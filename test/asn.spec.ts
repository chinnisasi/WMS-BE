import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { Database } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { InboundFacade } from '../src/modules/inbound/inbound.facade';
import { ASN_STATUSES } from '../src/modules/inbound/asn.command';
import { BLIND_REASON_CODES } from '../src/modules/inbound/receiving.command';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';

// Story 21-6 — advance shipment notices: the ASN lifecycle, receiving against
// a PO OR an ASN in one `grn.submit` (through the device route AND the
// sync-report replay path), the close-vs-approve serialisation, the hash rule
// that keeps every queued pre-21-6 op replayable, and the 0064 CHECKs.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;

jest.setTimeout(120_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const ENQUEUED_AT = new Date(Date.now() - 60_000).toISOString();

type Via = 'device' | 'replay';

interface GrnLine {
  poLineId?: string | null;
  asnLineId?: string | null;
  skuId: string;
  batchCode: string | null;
  mfgDate: string | null;
  qty: number;
  weightsGrams?: number[] | null;
}

interface GrnBody {
  warehouseId: string;
  poId?: string | null;
  asnId?: string | null;
  blindReasonCode?: string | null;
  occurredAt: string;
  lines: GrnLine[];
}

describe('advance shipment notices (e2e, story 21-6)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let operatorMemberToken: string;
  let wh1: string;
  let wh2: string;
  let vendorId: string;
  let selfClient: string;
  let acme: string;
  let beta: string;
  let acme1: string; // ACME SKU
  let acme2: string; // ACME SKU
  let beta1: string; // BETA SKU
  let self1: string; // self SKU (POs)
  let deviceToken: string;
  let operatorToken: string;
  let operatorUserId: string;
  let deviceId: string;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('asn');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2 });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `ASN Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await http().post(`${API}/sign-in`).send({ email, password: 'correct-horse-battery' }).expect(200)).body
      .accessToken as string;

    wh1 = await createWarehouse('ASN-W1');
    wh2 = await createWarehouse('ASN-W2');
    vendorId = (
      await http()
        .post(`${API}/${tenantId}/vendors`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'V-ASN', name: 'ASN Vendor' })
        .expect(201)
    ).body.vendor.id as string;

    const clients = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    selfClient = (clients.body.items as { id: string; systemOwned: boolean }[]).find((c) => c.systemOwned)!.id;
    acme = (await createClient('ACME', 'Acme Foods')).id;
    beta = (await createClient('BETA', 'Beta Brands')).id;

    await importCsv(['ACME-1,Acme One,pcs,1800,,,', 'ACME-2,Acme Two,pcs,1800,,,'], acme);
    await importCsv(['BETA-1,Beta One,pcs,1800,,,'], beta);
    await importCsv(['SELF-1,Self One,pcs,1800,,,'], selfClient);
    const skus = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    const byCode = new Map((skus.body.items as { code: string; id: string }[]).map((s) => [s.code, s.id]));
    acme1 = byCode.get('ACME-1')!;
    acme2 = byCode.get('ACME-2')!;
    beta1 = byCode.get('BETA-1')!;
    self1 = byCode.get('SELF-1')!;

    opsToken = (await createMember('ops_manager')).token;
    const operator = await createMember('operator');
    operatorMemberToken = operator.token;

    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'ASN dock', pin: '1357' })
      .expect(201);
    deviceToken = enrolled.body.deviceToken as string;
    deviceId = enrolled.body.device.id as string;
    const badged = await http()
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({ operatorEmail: operator.email, pin: '1357' })
      .expect(200);
    operatorToken = badged.body.accessToken as string;
    operatorUserId = badged.body.operator.id as string;
  });

  afterAll(async () => {
    await sql?.end();
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function createWarehouse(code: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `${code}-${ulid().slice(20)}`, name: `Warehouse ${code}` })
        .expect(201)
    ).body.id as string;
  }

  async function createClient(code: string, name: string): Promise<{ id: string }> {
    const res = await http()
      .post(`${API}/${tenantId}/clients`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code, name })
      .expect(201);
    return { id: res.body.client.id as string };
  }

  async function importCsv(rows: string[], clientId: string): Promise<void> {
    const csv = ['sku_code,name,uom,gst_rate,product,variant_values,kit_components', ...rows].join('\n');
    await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', clientId)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
  }

  async function createMember(role: 'ops_manager' | 'operator'): Promise<{ userId: string; token: string; email: string }> {
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
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    const token = (await http().post(`${API}/sign-in`).send({ email, password: 'correct-horse-battery' }).expect(200)).body
      .accessToken as string;
    return { userId: invited.body.user.id as string, token, email };
  }

  function createAsn(body: Record<string, unknown>, token = opsToken, key = ulid()): SupertestTest {
    return http().post(`${API}/${tenantId}/inbound/asns`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  function amendAsn(asnId: string, body: Record<string, unknown>, token = opsToken, key = ulid()): SupertestTest {
    return http().patch(`${API}/${tenantId}/inbound/asns/${asnId}`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  function transition(asnId: string, verb: 'close' | 'cancel', note: string, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/inbound/asns/${asnId}/${verb}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key)
      .send({ note });
  }

  function getAsn(asnId: string, token = opsToken): SupertestTest {
    return http().get(`${API}/${tenantId}/inbound/asns/${asnId}`).set('Authorization', `Bearer ${token}`);
  }

  interface AsnBody {
    id: string;
    code: string;
    status: string;
    statusNote: string | null;
    lines: { id: string; skuId: string; announcedQty: number; receivedQty: number; openQty: number }[];
  }

  async function newAsn(
    lines: { skuId: string; announcedQty: number }[],
    opts: { warehouseId?: string; clientId?: string; code?: string } = {},
  ): Promise<AsnBody> {
    const res = await createAsn({
      clientId: opts.clientId ?? acme,
      warehouseId: opts.warehouseId ?? wh1,
      asnCode: opts.code ?? `ASN-${ulid().slice(14)}`,
      lines,
    }).expect(201);
    return res.body.asn as AsnBody;
  }

  async function newPo(orderedQty: number, warehouseId = wh1): Promise<{ poId: string; lineId: string }> {
    const res = await http()
      .post(`${API}/${tenantId}/inbound/purchase-orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, vendorId, code: `PO-${ulid().slice(14)}`, lines: [{ skuId: self1, orderedQty, unitCostPaise: 100 }] })
      .expect(201);
    return { poId: res.body.purchaseOrder.id as string, lineId: res.body.purchaseOrder.lines[0].id as string };
  }

  function nowSecond(): string {
    // Millisecond form: the replay path re-normalises a stored instant to
    // `toISOString()`, so the same op hashes the same through both routes.
    return new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  }

  function line(skuId: string, qty: number, refs: { poLineId?: string; asnLineId?: string } = {}): GrnLine {
    return { skuId, batchCode: null, mfgDate: null, qty, ...refs };
  }

  /**
   * One receipt, through the device route or the sync-report REPLAY path
   * (a reported op re-applied by an owner — the command re-executes from
   * the stored payload, keyed by the op's own ULID). Both answer
   * `{status, body}` with the GRN body on success (201).
   */
  async function receive(body: GrnBody, via: Via, key = ulid()): Promise<{ status: number; body: Record<string, unknown> }> {
    if (via === 'device') {
      const res = await http()
        .post(`${API}/${tenantId}/receiving/goods-receipts`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, key)
        .send(body);
      return { status: res.status, body: res.body as Record<string, unknown> };
    }
    const opId = key;
    await http()
      .post(`${API}/${tenantId}/devices/sync-reports`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        rows: [
          {
            opId,
            opType: 'grn.submit',
            classification: 'rejected',
            problemCode: 'device-offline',
            problemDetail: 'Queued while offline',
            payload: body,
            attribution: { deviceLabel: 'ASN dock', operatorEmail: 'floor@example.com' },
            opEnqueuedAt: ENQUEUED_AT,
            opOccurredAt: null,
          },
        ],
      })
      .expect(201);
    const listed = await http()
      .get(`${API}/${tenantId}/rejected-ops`)
      .query({ status: 'open', limit: 200 })
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const row = (listed.body.items as { id: string; opId: string }[]).find((item) => item.opId === opId)!;
    const res = await http()
      .post(`${API}/${tenantId}/rejected-ops/${row.id}/resolve`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ decision: 'apply' });
    if (res.status === 200) {
      return { status: 201, body: res.body.outcome.snapshot as Record<string, unknown> };
    }
    return { status: res.status, body: res.body as Record<string, unknown> };
  }

  function asnReceipt(asn: AsnBody, lines: GrnLine[], warehouseId = wh1): GrnBody {
    return { warehouseId, asnId: asn.id, occurredAt: nowSecond(), lines };
  }

  async function pendingOverReceipts(): Promise<{ id: string; asnId?: string; asnLineId?: string; asnCode?: string; poId: string | null; excessQty: number }[]> {
    const res = await http()
      .get(`${API}/${tenantId}/receiving/over-receipts`)
      .query({ status: 'pending', limit: 200 })
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    return res.body.items;
  }

  function decide(overReceiptId: string, decision: 'approve' | 'reject', key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/receiving/over-receipts/${overReceiptId}/${decision}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key);
  }

  async function snapshotAsnIds(warehouseId = wh1): Promise<string[]> {
    const res = await http()
      .get(`${API}/${tenantId}/devices/catalog-snapshot`)
      .query({ warehouseId })
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    return (res.body.openAsns as { id: string }[]).map((a) => a.id);
  }

  /** One GRN's grn.received references, keyed `skuId:qty` (base units). */
  async function refsOf(grnId: string): Promise<Map<string, Record<string, unknown>>> {
    const rows = await sql<{ ref: Record<string, unknown>; sku: string; q: string }[]>`
      select reference_doc as ref, sku_id as sku, quantity_delta::text as q from ledger_events
      where tenant_id = ${tenantId} and type = 'grn.received' and reference_doc->>'grnId' = ${grnId}`;
    return new Map(rows.map((row) => [`${row.sku}:${Number(row.q) / 1000}`, row.ref]));
  }

  // ── vocabularies and CHECKs ────────────────────────────────────────────────

  describe('the 0064 vocabularies and CHECKs', () => {
    async function constraintDef(name: string): Promise<string> {
      const rows = await sql<{ def: string }[]>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}`;
      return rows[0]!.def;
    }

    it('ASN_STATUSES and the blind reasons are pinned against their CHECKs', async () => {
      const status = await constraintDef('advance_shipment_notices_status_check');
      const listed = [...status.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
      expect(listed).toEqual([...ASN_STATUSES].sort());
      const pairing = await constraintDef('goods_receipt_notes_blind_pairing');
      const reasons = [...pairing.matchAll(/'([a-z-]+)'::text/g)].map((m) => m[1]).sort();
      expect(reasons).toEqual([...BLIND_REASON_CODES].sort());
      expect(pairing).toContain('asn_id IS NOT NULL');
    });

    it('each new CHECK refuses what it must (23514), below the API', async () => {
      const t = uuidv7();
      const refused = async (statement: Promise<unknown>) => expect(statement).rejects.toMatchObject({ code: '23514' });
      const grn = (po: string | null, asn: string | null, reason: string | null) =>
        sql`insert into goods_receipt_notes (id, tenant_id, warehouse_id, code, po_id, asn_id, blind_reason_code, device_id, recorded_by, occurred_at, recorded_at)
          values (${uuidv7()}, ${t}, ${t}, ${'X-' + ulid()}, ${po}, ${asn}, ${reason}, ${t}, ${t}, now(), now())`;
      await refused(grn(uuidv7(), uuidv7(), null));
      await refused(grn(null, uuidv7(), 'other'));
      await refused(grn(uuidv7(), null, 'other'));
      await refused(grn(null, null, null)); // 0013's NULL IN (…) hole, closed
      await refused(grn(null, null, 'asn-not-found'));
      await refused(
        sql`insert into goods_receipt_lines (id, tenant_id, grn_id, po_line_id, asn_line_id, sku_id, qty, applied_qty)
          values (${uuidv7()}, ${t}, ${t}, ${uuidv7()}, ${uuidv7()}, ${t}, 1000, 1000)`,
      );
      const over = (po: string | null, poLine: string | null, asn: string | null, asnLine: string | null) =>
        sql`insert into over_receipts (id, tenant_id, warehouse_id, grn_id, grn_line_id, po_id, po_line_id, asn_id, asn_line_id, sku_id, excess_qty, requested_by, requested_at)
          values (${uuidv7()}, ${t}, ${t}, ${t}, ${t}, ${po}, ${poLine}, ${asn}, ${asnLine}, ${t}, 1000, ${t}, now())`;
      await refused(over(null, null, null, null));
      await refused(over(uuidv7(), uuidv7(), uuidv7(), uuidv7()));
      await refused(over(uuidv7(), null, null, uuidv7()));
      await refused(over(null, null, uuidv7(), null));
      const asnRow = (status: string, note: string | null, code = 'X') =>
        sql`insert into advance_shipment_notices (id, tenant_id, client_id, warehouse_id, asn_code, status, status_note)
          values (${uuidv7()}, ${t}, ${t}, ${t}, ${code}, ${status}, ${note})`;
      await refused(asnRow('open', null));
      await refused(asnRow('closed', null));
      await refused(asnRow('received', 'a note'));
      await refused(asnRow('announced', null, ''));
      await refused(sql`insert into asn_lines (id, tenant_id, asn_id, sku_id, announced_qty) values (${uuidv7()}, ${t}, ${t}, ${t}, 0)`);
      await refused(
        sql`insert into asn_lines (id, tenant_id, asn_id, sku_id, announced_qty, received_qty) values (${uuidv7()}, ${t}, ${t}, ${t}, 1000, -1)`,
      );
      // …and the accepted shapes land (a CHECK refusing everything fails here).
      await grn(uuidv7(), null, null);
      await grn(null, uuidv7(), null);
      await grn(null, null, 'other');
      await over(null, null, uuidv7(), uuidv7());
      await asnRow('cancelled', 'nothing came');
      await sql`delete from goods_receipt_notes where tenant_id = ${t}`;
      await sql`delete from over_receipts where tenant_id = ${t}`;
      await sql`delete from advance_shipment_notices where tenant_id = ${t}`;
    });
  });

  // ── the lifecycle ──────────────────────────────────────────────────────────

  describe('create, read, and the client rule', () => {
    it('creates an announced ASN that rides the device snapshot; a replay re-serves it; a changed body 422s', async () => {
      const key = ulid();
      const body = { clientId: acme, warehouseId: wh1, asnCode: ' ASN-CREATE ', expectedAt: '2026-10-20T04:30:00Z', lines: [{ skuId: acme1, announcedQty: 10 }, { skuId: acme2, announcedQty: 5 }] };
      const created = await createAsn(body, opsToken, key).expect(201);
      const asn = created.body.asn;
      expect(asn).toMatchObject({
        code: 'ASN-CREATE',
        clientId: acme,
        warehouseId: wh1,
        status: 'announced',
        expectedAt: '2026-10-20T04:30:00.000Z',
        statusNote: null,
        lineCount: 2,
        announcedTotal: 15,
        receivedTotal: 0,
      });
      expect(asn.lines.map((l: { openQty: number }) => l.openQty)).toEqual([10, 5]);
      expect((await createAsn(body, opsToken, key).expect(201)).body).toEqual(created.body);
      expect((await createAsn({ ...body, asnCode: 'OTHER' }, opsToken, key).expect(422)).body.code).toBe('idempotency-key-reuse');

      const snapshot = await http()
        .get(`${API}/${tenantId}/devices/catalog-snapshot`)
        .query({ warehouseId: wh1 })
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);
      const entry = (snapshot.body.openAsns as { id: string }[]).find((a) => a.id === asn.id);
      expect(entry).toEqual({
        id: asn.id,
        code: 'ASN-CREATE',
        clientId: acme,
        warehouseId: wh1,
        expectedAt: '2026-10-20T04:30:00.000Z',
        lines: asn.lines.map((l: Record<string, unknown>) => ({ ...l })),
      });
      expect(await snapshotAsnIds(wh2)).not.toContain(asn.id);

      // The detail and the list read it back; an audit row and an outbox event were written.
      expect((await getAsn(asn.id).expect(200)).body).toEqual(created.body);
      const list = await http()
        .get(`${API}/${tenantId}/warehouses/${wh1}/inbound/asns`)
        .query({ clientId: acme, status: 'announced' })
        .set('Authorization', `Bearer ${operatorMemberToken}`)
        .expect(200);
      expect((list.body.items as { id: string }[]).map((i) => i.id)).toContain(asn.id);
      const audits = await sql`select action from audit_events where target_id = ${asn.id}`;
      expect(audits.map((a) => a.action)).toEqual(['asn.created']);
      const events = await sql`select type from outbox_messages where tenant_id = ${tenantId} and type like 'asn.%' and payload->'asn'->>'id' = ${asn.id}`;
      expect(events.map((e) => e.type)).toEqual(['asn.created']);
    });

    it('client mismatch is 409 sku-client-mismatch; mixed SKUs are 409 mixed-client; an unknown client is 404', async () => {
      const mismatch = await createAsn({ clientId: acme, warehouseId: wh1, asnCode: 'X1', lines: [{ skuId: beta1, announcedQty: 1 }] }).expect(409);
      expect(mismatch.body.code).toBe('sku-client-mismatch');
      const mixed = await createAsn({ clientId: acme, warehouseId: wh1, asnCode: 'X2', lines: [{ skuId: acme1, announcedQty: 1 }, { skuId: beta1, announcedQty: 1 }] }).expect(409);
      expect(mixed.body.code).toBe('mixed-client');
      expect((await createAsn({ clientId: uuidv7(), warehouseId: wh1, asnCode: 'X3', lines: [{ skuId: acme1, announcedQty: 1 }] }).expect(404)).body.code).toBe('not-found');
      expect((await createAsn({ clientId: acme, warehouseId: uuidv7(), asnCode: 'X4', lines: [{ skuId: acme1, announcedQty: 1 }] }).expect(404)).body.code).toBe('not-found');
    });

    it('the same code for two clients is allowed; twice for one client is 409', async () => {
      await newAsn([{ skuId: acme1, announcedQty: 1 }], { code: 'ASN-001' });
      await newAsn([{ skuId: beta1, announcedQty: 1 }], { code: 'ASN-001', clientId: beta });
      const dup = await createAsn({ clientId: acme, warehouseId: wh1, asnCode: 'ASN-001', lines: [{ skuId: acme1, announcedQty: 1 }] }).expect(409);
      expect(dup.body.code).toBe('duplicate-asn-code');
    });

    it('asn.manage gates every write; a client-portal session is refused on reads AND writes (403)', async () => {
      const asn = await newAsn([{ skuId: acme1, announcedQty: 1 }]);
      expect((await createAsn({ clientId: acme, warehouseId: wh1, asnCode: 'OP', lines: [{ skuId: acme1, announcedQty: 1 }] }, operatorMemberToken).expect(403)).body.code).toBe('role-denied');
      // A client-portal user: a member whose row names a client.
      const portal = await createMember('ops_manager');
      // Story 21-7: the 0065 CHECK pairs a client with the `client` role, so the
      // fixture sets both — AFTER minting the token, so the token carries no
      // `client_id` claim and passes the operator fence: this still proves the
      // per-route refusal (the DB-read client), not the guard.
      await sql`update users set role = 'client', client_id = ${acme} where id = ${portal.userId}`;
      expect((await createAsn({ clientId: acme, warehouseId: wh1, asnCode: 'PORTAL', lines: [{ skuId: acme1, announcedQty: 1 }] }, portal.token).expect(403)).body.code).toBe('role-denied');
      await getAsn(asn.id, portal.token).expect(403);
      await http().get(`${API}/${tenantId}/warehouses/${wh1}/inbound/asns`).set('Authorization', `Bearer ${portal.token}`).expect(403);
      await getAsn(uuidv7()).expect(404);
      await getAsn('not-a-uuid').expect(400);
    });
  });

  // ── receiving against an ASN: every matrix row, through both routes ────────

  describe.each<Via>(['device', 'replay'])('receiving against an ASN — via the %s route', (via) => {
    it('partial → over → approve (the acceptance criterion): 60 then 50 of 100 ends received, 10 pends, approval makes 110', async () => {
      const asn = await newAsn([{ skuId: acme1, announcedQty: 100 }]);
      const lineId = asn.lines[0]!.id;
      const first = await receive(asnReceipt(asn, [line(acme1, 60, { asnLineId: lineId })]), via);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ goodsReceipt: { asnId: asn.id, asnCode: asn.code, poId: null, blindReasonCode: null } });
      expect((await getAsn(asn.id).expect(200)).body.asn).toMatchObject({ status: 'partially_received', receivedTotal: 60 });
      expect(await snapshotAsnIds()).toContain(asn.id);

      const second = await receive(asnReceipt(asn, [line(acme1, 50, { asnLineId: lineId })]), via);
      expect(second.status).toBe(201);
      const grnLine = (second.body.goodsReceipt as { lines: Record<string, unknown>[] }).lines[0]!;
      expect(grnLine).toMatchObject({ asnLineId: lineId, poLineId: null, qty: 50, appliedQty: 40, excessQty: 10 });
      const after = (await getAsn(asn.id).expect(200)).body.asn;
      expect(after).toMatchObject({ status: 'received', receivedTotal: 100 });
      expect(await snapshotAsnIds()).not.toContain(asn.id);

      const pending = (await pendingOverReceipts()).filter((o) => o.asnId === asn.id);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ asnLineId: lineId, asnCode: asn.code, poId: null, excessQty: 10 });
      const approved = await decide(pending[0]!.id, 'approve').expect(200);
      expect(approved.body.overReceipt).toMatchObject({ status: 'approved', asnId: asn.id, asnLineId: lineId, asnCode: asn.code });
      const final = (await getAsn(asn.id).expect(200)).body.asn;
      expect(final).toMatchObject({ status: 'received', receivedTotal: 110 });
      expect(final.lines[0]).toMatchObject({ receivedQty: 110, openQty: -10 });

      // Every grn.received names the ASN and its line — submit AND approve.
      const grnIds = [first.body, second.body].map((b) => (b.goodsReceipt as { id: string }).id);
      const events = await sql<{ ref: Record<string, unknown>; q: string }[]>`
        select reference_doc as ref, quantity_delta::text as q from ledger_events
        where tenant_id = ${tenantId} and type = 'grn.received' and reference_doc->>'grnId' in ${sql(grnIds)} order by seq`;
      expect(events.map((e) => Number(e.q) / 1000)).toEqual([60, 40, 10]);
      for (const event of events) {
        expect(event.ref).toEqual({ kind: 'grn-receipt', grnId: event.ref.grnId, asnId: asn.id, asnLineId: lineId });
      }

      // Each GRN line counts once for ACME's inbound_handling.
      const inbound = app.get(InboundFacade);
      const db = app.get<Database>(DATABASE);
      const counted = await withTenantTransaction(db, tenantId, async (tx) => {
        const records = await inbound.receiptLineRecordsInTx(
          tx,
          { tenantId, clientId: acme },
          '2000-01-01T00:00:00Z',
          '2100-01-01T00:00:00Z',
          { after: null, limit: 1000 },
        );
        return records.filter((r) => r.asnCode === asn.code);
      });
      expect(counted).toHaveLength(2);
      expect(counted.every((r) => r.poCode === null)).toBe(true);
    });

    it('a closed ASN is 409 asn-not-open; two references are 400; a GRN in another warehouse is 409 document-warehouse-mismatch', async () => {
      const asn = await newAsn([{ skuId: acme1, announcedQty: 10 }]);
      const lineId = asn.lines[0]!.id;
      const wrongWarehouse = await receive(asnReceipt(asn, [line(acme1, 1, { asnLineId: lineId })], wh2), via);
      expect(wrongWarehouse.status).toBe(409);
      expect(wrongWarehouse.body.code).toBe('document-warehouse-mismatch');

      const { poId, lineId: poLineId } = await newPo(5);
      const twoRefs = await receive({ ...asnReceipt(asn, [line(acme1, 1)]), poId }, via);
      expect(twoRefs.status).toBe(400);
      const asnLineOnPo = await receive({ warehouseId: wh1, poId, occurredAt: nowSecond(), lines: [line(self1, 1, { asnLineId: lineId })] }, via);
      expect(asnLineOnPo.status).toBe(400);
      const poLineOnAsn = await receive(asnReceipt(asn, [line(acme1, 1, { poLineId })]), via);
      expect(poLineOnAsn.status).toBe(400);
      const none = await receive({ warehouseId: wh1, occurredAt: nowSecond(), lines: [line(acme1, 1)] }, via);
      expect(none.status).toBe(400);
      const poWrongWarehouse = await receive({ warehouseId: wh2, poId, occurredAt: nowSecond(), lines: [line(self1, 1, { poLineId })] }, via);
      expect(poWrongWarehouse.status).toBe(409);
      expect(poWrongWarehouse.body.code).toBe('document-warehouse-mismatch');

      expect((await receive(asnReceipt(asn, [line(acme1, 4, { asnLineId: lineId })]), via)).status).toBe(201);
      await transition(asn.id, 'close', 'Short shipment — six never came').expect(200);
      const closed = await receive(asnReceipt(asn, [line(acme1, 1, { asnLineId: lineId })]), via);
      expect(closed.status).toBe(409);
      expect(closed.body.code).toBe('asn-not-open');
      expect(await snapshotAsnIds()).not.toContain(asn.id);
    });

    it('a SKU mismatch or a missing line reference settles UNMATCHED (applied in full, line not credited); an unknown line is rejected', async () => {
      const asn = await newAsn([{ skuId: acme1, announcedQty: 10 }, { skuId: acme2, announcedQty: 10 }]);
      const [l1, l2] = asn.lines;
      const res = await receive(
        asnReceipt(asn, [
          line(acme2, 3, { asnLineId: l1!.id }), // SKU mismatch
          line(acme1, 2), // no reference
          line(acme2, 4, { asnLineId: l2!.id }), // matched
          line(acme1, 1, { asnLineId: uuidv7() }), // unknown line
        ]),
        via,
      );
      expect(res.status).toBe(201);
      const grn = res.body.goodsReceipt as {
        lines: { asnLineId?: string; qty: number; appliedQty: number; excessQty: number }[];
        unmatchedLines: unknown;
        rejectedLines: { code: string; asnLineId: string; poLineId: string | null }[];
      };
      expect(grn.unmatchedLines).toEqual([
        { index: 0, reason: 'line-sku-mismatch' },
        { index: 1, reason: 'no-line-reference' },
      ]);
      expect(grn.lines.map((l) => [l.asnLineId ?? null, l.appliedQty, l.excessQty])).toEqual([
        [null, 3, 0],
        [null, 2, 0],
        [l2!.id, 4, 0],
      ]);
      expect(grn.rejectedLines).toHaveLength(1);
      expect(grn.rejectedLines[0]).toMatchObject({ code: 'asn-line-not-found', poLineId: null });
      const after = (await getAsn(asn.id).expect(200)).body.asn;
      expect(after.lines.map((l: { receivedQty: number }) => l.receivedQty)).toEqual([0, 4]);
      expect(after.status).toBe('partially_received');

      // The unmatched lines' grn.received names the ASN and NO line.
      const grnId = (res.body.goodsReceipt as { id: string }).id;
      const refs = await refsOf(grnId);
      expect(refs.get(`${acme2}:3`)).toEqual({ kind: 'grn-receipt', grnId, asnId: asn.id });
      expect(refs.get(`${acme1}:2`)).toEqual({ kind: 'grn-receipt', grnId, asnId: asn.id });
      expect(refs.get(`${acme2}:4`)).toEqual({ kind: 'grn-receipt', grnId, asnId: asn.id, asnLineId: l2!.id });
    });

    it('a PO line whose SKU differs settles unmatched too — the PO line is not bumped, the goods are booked', async () => {
      const { poId, lineId } = await newPo(10);
      const res = await receive({ warehouseId: wh1, poId, occurredAt: nowSecond(), lines: [line(acme1, 3, { poLineId: lineId })] }, via);
      expect(res.status).toBe(201);
      const grn = res.body.goodsReceipt as { lines: { poLineId: string | null; appliedQty: number }[]; unmatchedLines: unknown };
      expect(grn.unmatchedLines).toEqual([{ index: 0, reason: 'line-sku-mismatch' }]);
      expect(grn.lines[0]).toMatchObject({ poLineId: null, appliedQty: 3 });
      const po = await http().get(`${API}/${tenantId}/inbound/purchase-orders/${poId}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      expect(po.body.purchaseOrder.lines[0].receivedQty).toBe(0);
      const grnId = (res.body.goodsReceipt as { id: string }).id;
      expect((await refsOf(grnId)).get(`${acme1}:3`)).toEqual({ kind: 'grn-receipt', grnId, poId });
    });

    it('a late receipt on a RECEIVED ASN is accepted: everything beyond announced pends as an over-receipt (spec change log 2026-10-08)', async () => {
      const asn = await newAsn([{ skuId: acme1, announcedQty: 10 }]);
      const lineId = asn.lines[0]!.id;
      expect((await receive(asnReceipt(asn, [line(acme1, 10, { asnLineId: lineId })]), via)).status).toBe(201);
      expect((await getAsn(asn.id).expect(200)).body.asn.status).toBe('received');
      expect(await snapshotAsnIds()).not.toContain(asn.id); // the snapshot lists only open ASNs
      const late = await receive(asnReceipt(asn, [line(acme1, 5, { asnLineId: lineId })]), via);
      expect(late.status).toBe(201);
      expect((late.body.goodsReceipt as { lines: Record<string, unknown>[] }).lines[0]).toMatchObject({ asnLineId: lineId, appliedQty: 0, excessQty: 5 });
      const pending = (await pendingOverReceipts()).filter((o) => o.asnId === asn.id);
      expect(pending.map((o) => o.excessQty)).toEqual([5]);
      expect((await getAsn(asn.id).expect(200)).body.asn).toMatchObject({ status: 'received', receivedTotal: 10 });    });
  });

  // ── close, cancel, amend ───────────────────────────────────────────────────

  describe('the explicit transitions and the close guard (decision 3)', () => {
    it('close is refused while an over-receipt is pending (ASN and PO); after the decision it closes with its note and leaves the snapshot', async () => {
      const asn = await newAsn([{ skuId: acme1, announcedQty: 10 }, { skuId: acme2, announcedQty: 10 }]);
      await receive(asnReceipt(asn, [line(acme1, 12, { asnLineId: asn.lines[0]!.id })]), 'device');
      expect((await getAsn(asn.id).expect(200)).body.asn.status).toBe('partially_received');
      const blocked = await transition(asn.id, 'close', 'short').expect(409);
      expect(blocked.body.code).toBe('over-receipt-pending');
      const pending = (await pendingOverReceipts()).find((o) => o.asnId === asn.id)!;
      await decide(pending.id, 'reject').expect(200);
      expect((await getAsn(asn.id).expect(200)).body.asn.lines[0].receivedQty).toBe(10); // reject never lowers it
      const closed = await transition(asn.id, 'close', '  Second line never shipped  ').expect(200);
      expect(closed.body.asn).toMatchObject({ status: 'closed', statusNote: 'Second line never shipped' });
      expect(await snapshotAsnIds()).not.toContain(asn.id);
      expect((await transition(asn.id, 'close', 'again').expect(409)).body.code).toBe('asn-transition-invalid');

      const { poId, lineId } = await newPo(5);
      await receive({ warehouseId: wh1, poId, occurredAt: nowSecond(), lines: [line(self1, 7, { poLineId: lineId })] }, 'device');
      const poClose = await http()
        .post(`${API}/${tenantId}/inbound/purchase-orders/${poId}/close`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ lines: [{ lineId, disposition: 'cancelled' }] })
        .expect(409);
      expect(poClose.body.code).toBe('over-receipt-pending');
    });

    it('a pending over-receipt left on a PO closed before 21-6 still approves and rejects', async () => {
      const a = await newPo(5);
      const b = await newPo(5);
      await receive({ warehouseId: wh1, poId: a.poId, occurredAt: nowSecond(), lines: [line(self1, 8, { poLineId: a.lineId })] }, 'device');
      await receive({ warehouseId: wh1, poId: b.poId, occurredAt: nowSecond(), lines: [line(self1, 9, { poLineId: b.lineId })] }, 'device');
      // The pre-21-6 state: the PO was closed while its excess pended.
      await sql`update purchase_orders set status = 'closed' where id in ${sql([a.poId, b.poId])}`;
      const pending = await pendingOverReceipts();
      const pa = pending.find((o) => o.poId === a.poId)!;
      const pb = pending.find((o) => o.poId === b.poId)!;
      await decide(pa.id, 'approve').expect(200);
      await decide(pb.id, 'reject').expect(200);
      const rows = await sql<{ received: string }[]>`select received_qty::text as received from purchase_order_lines where id = ${a.lineId}`;
      expect(Number(rows[0]!.received)).toBe(8000);
    });

    it('cancel only an untouched ASN; close only a partially received one; a note is required', async () => {
      const untouched = await newAsn([{ skuId: acme1, announcedQty: 10 }]);
      expect((await transition(untouched.id, 'close', 'nope').expect(409)).body.code).toBe('asn-transition-invalid');
      expect((await transition(untouched.id, 'cancel', '   ').expect(400)).body.code).toBe('validation-failed');
      expect((await transition(untouched.id, 'cancel', 'x'.repeat(501)).expect(400)).body.code).toBe('validation-failed');
      const key = ulid();
      const cancelled = await transition(untouched.id, 'cancel', 'Client withdrew it', key).expect(200);
      expect(cancelled.body.asn).toMatchObject({ status: 'cancelled', statusNote: 'Client withdrew it' });
      expect((await transition(untouched.id, 'cancel', 'Client withdrew it', key).expect(200)).body).toEqual(cancelled.body);
      expect(await snapshotAsnIds()).not.toContain(untouched.id);

      const touched = await newAsn([{ skuId: acme1, announcedQty: 10 }]);
      await receive(asnReceipt(touched, [line(acme1, 1, { asnLineId: touched.lines[0]!.id })]), 'device');
      expect((await transition(touched.id, 'cancel', 'too late').expect(409)).body.code).toBe('asn-transition-invalid');
      expect((await transition(touched.id, 'close', 'short by nine').expect(200)).body.asn.status).toBe('closed');
    });

    it('close versus approve serialise on the document lock: approve always lands, close either waits for it or refuses', async () => {
      for (let round = 0; round < 4; round += 1) {
        const asn = await newAsn([{ skuId: acme1, announcedQty: 10 }, { skuId: acme2, announcedQty: 10 }]);
        await receive(asnReceipt(asn, [line(acme1, 13, { asnLineId: asn.lines[0]!.id })]), 'device');
        const pending = (await pendingOverReceipts()).find((o) => o.asnId === asn.id)!;
        const [closeRes, approveRes] = await Promise.all([transition(asn.id, 'close', 'race'), decide(pending.id, 'approve')]);
        expect(approveRes.status).toBe(200);
        expect([200, 409]).toContain(closeRes.status);
        if (closeRes.status === 409) expect(closeRes.body.code).toBe('over-receipt-pending');
        const after = (await getAsn(asn.id).expect(200)).body.asn;
        expect(after.lines[0].receivedQty).toBe(13);
        expect(after.status).toBe(closeRes.status === 200 ? 'closed' : 'partially_received');
      }
    });
  });

  describe('amend', () => {
    it('refuses to remove, re-SKU or under-announce a received line (ASN and PO alike); lowering to received completes the ASN', async () => {
      const asn = await newAsn([{ skuId: acme1, announcedQty: 10 }, { skuId: acme2, announcedQty: 5 }]);
      const [l1, l2] = asn.lines;
      await receive(asnReceipt(asn, [line(acme1, 6, { asnLineId: l1!.id })]), 'device');
      const keep2 = { id: l2!.id, skuId: acme2, announcedQty: 5 };
      expect((await amendAsn(asn.id, { lines: [keep2] }).expect(409)).body.code).toBe('asn-line-received');
      expect((await amendAsn(asn.id, { lines: [{ id: l1!.id, skuId: acme2, announcedQty: 10 }, keep2] }).expect(409)).body.code).toBe('asn-line-received');
      expect((await amendAsn(asn.id, { lines: [{ id: l1!.id, skuId: acme1, announcedQty: 5 }, keep2] }).expect(409)).body.code).toBe('asn-line-received');
      expect((await amendAsn(asn.id, { lines: [{ id: l1!.id, skuId: acme1, announcedQty: 10 }, { skuId: beta1, announcedQty: 1 }] }).expect(409)).body.code).toBe('sku-client-mismatch');
      expect((await amendAsn(asn.id, { lines: [{ id: uuidv7(), skuId: acme1, announcedQty: 1 }] }).expect(404)).body.code).toBe('not-found');

      // Drop the untouched line and lower line 1 to what it received: complete.
      const done = await amendAsn(asn.id, { expectedAt: null, lines: [{ id: l1!.id, skuId: acme1, announcedQty: 6 }] }).expect(200);
      expect(done.body.asn).toMatchObject({ status: 'received', lineCount: 1, announcedTotal: 6, receivedTotal: 6 });
      expect((await amendAsn(asn.id, { lines: [{ id: l1!.id, skuId: acme1, announcedQty: 7 }] }).expect(409)).body.code).toBe('asn-not-open');

      const { poId, lineId } = await newPo(10);
      await receive({ warehouseId: wh1, poId, occurredAt: nowSecond(), lines: [line(self1, 4, { poLineId: lineId })] }, 'device');
      const amendPo = (lines: Record<string, unknown>[]) =>
        http().patch(`${API}/${tenantId}/inbound/purchase-orders/${poId}`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ lines });
      expect((await amendPo([{ skuId: self1, orderedQty: 3, unitCostPaise: 100 }]).expect(409)).body.code).toBe('po-line-received');
      expect((await amendPo([{ id: lineId, skuId: self1, orderedQty: 3, unitCostPaise: 100 }]).expect(409)).body.code).toBe('po-line-received');
      await amendPo([{ id: lineId, skuId: self1, orderedQty: 4, unitCostPaise: 100 }]).expect(200);
    });

    it('after an APPROVED over-receipt (received > announced/ordered) resending the line unchanged still amends — only a lowered quantity below received refuses', async () => {
      const asn = await newAsn([{ skuId: acme1, announcedQty: 10 }, { skuId: acme2, announcedQty: 5 }]);
      const [l1, l2] = asn.lines;
      await receive(asnReceipt(asn, [line(acme1, 12, { asnLineId: l1!.id })]), 'device');
      await decide((await pendingOverReceipts()).find((o) => o.asnId === asn.id)!.id, 'approve').expect(200);
      const unchanged = [
        { id: l1!.id, skuId: acme1, announcedQty: 10 },
        { id: l2!.id, skuId: acme2, announcedQty: 5 },
      ];
      const amended = await amendAsn(asn.id, { expectedAt: '2026-11-01T04:30:00Z', lines: unchanged }).expect(200);
      expect(amended.body.asn).toMatchObject({ status: 'partially_received', expectedAt: '2026-11-01T04:30:00.000Z' });
      expect(amended.body.asn.lines[0]).toMatchObject({ announcedQty: 10, receivedQty: 12 });
      expect((await amendAsn(asn.id, { lines: [{ ...unchanged[0]!, announcedQty: 9 }, unchanged[1]] }).expect(409)).body.code).toBe('asn-line-received');
      await amendAsn(asn.id, { lines: [{ ...unchanged[0]!, announcedQty: 11 }, unchanged[1]] }).expect(200);

      const { poId, lineId } = await newPo(5);
      await receive({ warehouseId: wh1, poId, occurredAt: nowSecond(), lines: [line(self1, 7, { poLineId: lineId })] }, 'device');
      await decide((await pendingOverReceipts()).find((o) => o.poId === poId)!.id, 'approve').expect(200);
      const amendPo = (orderedQty: number) =>
        http()
          .patch(`${API}/${tenantId}/inbound/purchase-orders/${poId}`)
          .set('Authorization', `Bearer ${opsToken}`)
          .set(KEY_HEADER, ulid())
          .send({ lines: [{ id: lineId, skuId: self1, orderedQty, unitCostPaise: 100 }] });
      const po = await amendPo(5).expect(200);
      expect(po.body.purchaseOrder.lines[0]).toMatchObject({ orderedQty: 5, receivedQty: 7 });
      expect((await amendPo(4).expect(409)).body.code).toBe('po-line-received');
      await amendPo(6).expect(200);
    });
  });

  describe('cancel with receipts, and the drill’s same-client rule', () => {
    it('an ASN whose only receipt credited no line stays announced, but cannot be cancelled (409 asn-has-receipts)', async () => {
      const asn = await newAsn([{ skuId: acme1, announcedQty: 10 }]);
      expect((await receive(asnReceipt(asn, [line(acme1, 2)]), 'device')).status).toBe(201); // unmatched
      expect((await getAsn(asn.id).expect(200)).body.asn.status).toBe('announced');
      expect((await transition(asn.id, 'cancel', 'nothing came?').expect(409)).body.code).toBe('asn-has-receipts');
      const untouched = await newAsn([{ skuId: acme1, announcedQty: 1 }]);
      await transition(untouched.id, 'cancel', 'withdrawn').expect(200);
    });

    it('a line of another client’s SKU on ACME’s ASN or PO never shows ACME’s document code in that client’s drill', async () => {
      const asn = await newAsn([{ skuId: acme1, announcedQty: 10 }]);
      await receive(asnReceipt(asn, [line(acme1, 1, { asnLineId: asn.lines[0]!.id }), line(beta1, 2)]), 'device');
      const { poId } = await newPo(5);
      await receive({ warehouseId: wh1, poId, occurredAt: nowSecond(), lines: [line(beta1, 4)] }, 'device');
      const inbound = app.get(InboundFacade);
      const db = app.get<Database>(DATABASE);
      const drill = (clientId: string) =>
        withTenantTransaction(db, tenantId, (tx) =>
          inbound.receiptLineRecordsInTx(tx, { tenantId, clientId }, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z', { after: null, limit: 1000 }),
        );
      const betaRows = await drill(beta);
      expect(betaRows.length).toBeGreaterThanOrEqual(2);
      expect(betaRows.every((r) => r.asnCode === null && r.poCode === null)).toBe(true);
      // …and those lines are NOT blind: the flag, not the missing code, says blind.
      expect(betaRows.every((r) => r.blind === false)).toBe(true);
      const blindGrn = await receive({ warehouseId: wh1, blindReasonCode: 'other', occurredAt: nowSecond(), lines: [line(beta1, 1)] }, 'device');
      const blindCode = (blindGrn.body.goodsReceipt as { code: string }).code;
      const after = await drill(beta);
      expect(after.filter((r) => r.grnCode === blindCode).map((r) => r.blind)).toEqual([true]);
      expect(after.filter((r) => r.grnCode !== blindCode).every((r) => r.blind === false)).toBe(true);
      expect((await drill(acme)).some((r) => r.asnCode === asn.code)).toBe(true);
    });
  });

  describe('the warehouse list', () => {
    it('totals and linesComplete follow receipts; each filter excludes a non-matching ASN; a limit=1 cursor walk sees each ASN once', async () => {
      const wh = await createWarehouse('ASN-WL');
      const a = await newAsn([{ skuId: acme1, announcedQty: 10 }, { skuId: acme2, announcedQty: 5 }], { warehouseId: wh });
      const b = await newAsn([{ skuId: beta1, announcedQty: 3 }], { warehouseId: wh, clientId: beta });
      const c = await newAsn([{ skuId: acme1, announcedQty: 1 }], { warehouseId: wh });
      await receive(asnReceipt(a, [line(acme2, 5, { asnLineId: a.lines[1]!.id })], wh), 'device');
      const list = (query: Record<string, string | number>) =>
        http().get(`${API}/${tenantId}/warehouses/${wh}/inbound/asns`).query(query).set('Authorization', `Bearer ${opsToken}`);
      const all = (await list({}).expect(200)).body.items as { id: string; status: string; lineCount: number; linesComplete: number; announcedTotal: number; receivedTotal: number }[];
      expect(all.map((r) => r.id)).toEqual([c.id, b.id, a.id]);
      expect(all[2]).toMatchObject({ status: 'partially_received', lineCount: 2, linesComplete: 1, announcedTotal: 15, receivedTotal: 5 });
      expect(all[1]).toMatchObject({ lineCount: 1, linesComplete: 0, receivedTotal: 0 });
      expect((await getAsn(a.id).expect(200)).body.asn.linesComplete).toBe(1);
      const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
      expect(ids((await list({ status: 'partially_received' }).expect(200)).body.items)).toEqual([a.id]);
      expect(ids((await list({ status: 'announced' }).expect(200)).body.items)).toEqual([c.id, b.id]);
      expect(ids((await list({ clientId: beta }).expect(200)).body.items)).toEqual([b.id]);
      expect(ids((await list({ clientId: acme }).expect(200)).body.items)).toEqual([c.id, a.id]);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let hop = 0; hop < 5; hop += 1) {
        const page = (await list(cursor === null ? { limit: 1 } : { limit: 1, cursor }).expect(200)).body as { items: { id: string }[]; nextCursor?: string | null };
        seen.push(...ids(page.items));
        cursor = page.nextCursor ?? null;
        if (cursor === null) break;
      }
      expect(seen).toEqual([c.id, b.id, a.id]);
      expect((await list({ cursor: 'garbage' }).expect(400)).body.code).toBe('invalid-cursor');
    });
  });

  // ── old ops: the hash rule ─────────────────────────────────────────────────

  describe('a pre-21-6 op still replays', () => {
    it('pins the pre-21-6 hash: a PO op hashes byte-for-byte as before, and its queued twin replays through the sync-report path', async () => {
      const { poId, lineId } = await newPo(10);
      const occurredAt = '2026-10-08T05:00:00.000Z';
      const body = { warehouseId: wh1, poId, blindReasonCode: null, occurredAt, lines: [{ poLineId: lineId, skuId: self1, batchCode: null, mfgDate: null, qty: 2 }] };
      const key = ulid();
      const original = await receive(body, 'device', key);
      expect(original.status).toBe(201);
      // The golden: the pre-21-6 fingerprint, written out key by key — no
      // asnId, no asnLineId. An always-present `asnId: null` would fail here.
      const golden =
        `{"tenantId":"${tenantId}","deviceId":"${deviceId}","operatorUserId":"${operatorUserId}","warehouseId":"${wh1}",` +
        `"poId":"${poId}","blindReasonCode":null,"occurredAt":"${occurredAt}",` +
        `"lines":[{"poLineId":"${lineId}","skuId":"${self1}","batchCode":null,"mfgDate":null,"qty":2}]}`;
      const stored = await sql<{ payload_hash: string }[]>`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`;
      expect(stored[0]!.payload_hash).toBe(createHash('sha256').update(golden, 'utf8').digest('hex'));

      // The same op, queued on the device and re-applied from its stored
      // payload (keyed by its own ULID): the hash matches, so it REPLAYS.
      const replayed = await receive(body, 'replay', key);
      expect(replayed.status).toBe(201);
      expect(replayed.body).toEqual(original.body);
    });

    it('a stored pre-21-6 blind payload (lines without asnLineId) re-applies cleanly', async () => {
      const res = await receive(
        { warehouseId: wh1, poId: null, blindReasonCode: 'unannounced-delivery', occurredAt: nowSecond(), lines: [{ poLineId: null, skuId: acme1, batchCode: null, mfgDate: null, qty: 3, weightsGrams: null }] },
        'replay',
      );
      expect(res.status).toBe(201);
      expect(res.body.goodsReceipt).toMatchObject({ poId: null, blindReasonCode: 'unannounced-delivery' });
      expect(res.body.goodsReceipt).not.toHaveProperty('asnId');
      expect(res.body.goodsReceipt).not.toHaveProperty('unmatchedLines');
    });
  });

  // ── the read models ────────────────────────────────────────────────────────

  describe('views', () => {
    it('the GRN list names the ASN and the blind filter (and its poless alias) excludes it; the blind KPI counts only the blind receipt', async () => {
      const wh3 = await createWarehouse('ASN-W3');
      const asn = await newAsn([{ skuId: acme1, announcedQty: 5 }], { warehouseId: wh3 });
      const asnGrn = await receive(asnReceipt(asn, [line(acme1, 2, { asnLineId: asn.lines[0]!.id })], wh3), 'device');
      const blindGrn = await receive({ warehouseId: wh3, blindReasonCode: 'other', occurredAt: nowSecond(), lines: [line(acme1, 1)] }, 'device');
      const list = (query: Record<string, string>) =>
        http().get(`${API}/${tenantId}/receiving/goods-receipts`).query({ warehouseId: wh3, ...query }).set('Authorization', `Bearer ${opsToken}`);
      const all = (await list({}).expect(200)).body.items as { id: string; asnId?: string; asnCode?: string; blindReasonCode: string | null }[];
      const asnRow = all.find((r) => r.id === (asnGrn.body.goodsReceipt as { id: string }).id)!;
      expect(asnRow).toMatchObject({ asnId: asn.id, asnCode: asn.code, poId: null, blindReasonCode: null });
      const blindRow = all.find((r) => r.id === (blindGrn.body.goodsReceipt as { id: string }).id)!;
      expect(blindRow).not.toHaveProperty('asnId');
      const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
      expect(ids((await list({ blind: 'true' }).expect(200)).body.items)).toEqual([blindRow.id]);
      expect(ids((await list({ poless: 'true' }).expect(200)).body.items)).toEqual([blindRow.id]);
      expect(ids((await list({ blind: 'false' }).expect(200)).body.items)).toEqual([asnRow.id]);
      expect((await list({ blind: 'true', poless: 'false' }).expect(400)).body.code).toBe('validation-failed');

      const overview = await http()
        .get(`${API}/${tenantId}/warehouses/${wh3}/reporting/overview`)
        .set('Authorization', `Bearer ${opsToken}`)
        .expect(200);
      const blind = overview.body.tiles.grnVariances.blindGrns;
      expect(blind.today.value).toBe(1);
      expect(blind.today.drill.query).toMatchObject({ blind: 'true' });
    });
  });

  it('asn_lines joined the SKU client-correction history probe (a SKU on an ASN has history)', async () => {
    await importCsv(['ACME-H,Acme History,pcs,1800,,,'], acme);
    const skus = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    const skuId = (skus.body.items as { code: string; id: string }[]).find((s) => s.code === 'ACME-H')!.id;
    await newAsn([{ skuId, announcedQty: 1 }]);
    const res = await http()
      .post(`${API}/${tenantId}/catalog/skus/${skuId}/client`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ clientId: beta })
      .expect(409);
    expect(res.body.code).toBe('sku-has-history');
    expect(res.body.detail).toContain('advance shipment notice lines');
  });

  it('the OpenAPI document lists the ASN routes', async () => {
    const doc = await http().get('/api/v1/openapi.json').expect(200);
    const paths = Object.keys(doc.body.paths as Record<string, unknown>);
    for (const path of [
      '/tenants/{tenantId}/inbound/asns',
      '/tenants/{tenantId}/warehouses/{warehouseId}/inbound/asns',
      '/tenants/{tenantId}/inbound/asns/{asnId}',
      '/tenants/{tenantId}/inbound/asns/{asnId}/close',
      '/tenants/{tenantId}/inbound/asns/{asnId}/cancel',
    ]) {
      expect(paths).toContain(path);
    }
  });
});
