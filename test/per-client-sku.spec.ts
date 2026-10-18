import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { createDatabase, type Database } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { skuCodeLabelsInTx } from '../src/modules/clients/clients.facade';
import { InvoicingFacade } from '../src/modules/invoicing/facade';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';

// Story 1-1 — per-client SKU identity: code and barcode unique per (tenant,
// client) (migration 0076), the GRN's client (stamped on every new receipt;
// a blind receipt's line of another client refused PER LINE and raised for
// review, Discard only), the hash rule that keeps every queued older blind op
// replayable, the snapshot's client fields, the catalog/ASN-import lookups
// by code within a client, the SKU client correction's collision check, the
// HSN hint by SKU, and the migration's backfill and probes.
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
const GTIN = '8901000000011';
const G29 = '29AAAPZ1234C1ZV';

interface GrnLine {
  poLineId?: string | null;
  skuId: string;
  batchCode: string | null;
  mfgDate: string | null;
  qty: number;
}

interface GrnBody {
  warehouseId: string;
  poId?: string | null;
  asnId?: string | null;
  blindReasonCode?: string | null;
  clientId?: string;
  occurredAt: string;
  lines: GrnLine[];
}

interface GoodsReceipt {
  id: string;
  code: string;
  clientId?: string;
  lines: { skuId: string; qty: number }[];
  rejectedLines?: { poLineId: string | null; skuId: string; qty: number; code: string; reason: string }[];
  unmatchedLines?: { index: number; reason: string }[];
  reviewOpId?: string;
}

describe('story 1-1: per-client SKU identity (e2e)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;

  let tenantId: string;
  let tenantName: string;
  let ownerToken: string;
  let wh: string;
  let vendorId: string;
  let selfClient: string;
  let acme: string;
  let beta: string;
  let deviceId: string;
  let operatorToken: string;
  let operatorUserId: string;
  /** `${clientCode}:${skuCode}` → id */
  const skuIds = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const sku = (client: 'ACME' | 'BETA' | 'SELF', code: string): string => {
    const id = skuIds.get(`${client}:${code}`);
    if (id === undefined) throw new Error(`unknown fixture SKU ${client}:${code}`);
    return id;
  };

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('per_client_sku');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2 });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    tenantName = `PCS Co ${ulid()}`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: tenantName, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;

    wh = (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `PCS-${ulid().slice(20)}`, name: 'PCS warehouse' })
        .expect(201)
    ).body.id as string;
    vendorId = (
      await http()
        .post(`${API}/${tenantId}/vendors`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'V-PCS', name: 'PCS Vendor' })
        .expect(201)
    ).body.vendor.id as string;

    const clients = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    selfClient = (clients.body.items as { id: string; systemOwned: boolean }[]).find((c) => c.systemOwned)!.id;
    acme = await createClient('ACME', 'Acme Apparel');
    beta = await createClient('BETA', 'Beta Brands');

    // Both brands own TSHIRT-M and sell it under ONE GTIN (matrix row 1).
    const acmeRun = await importCsv(
      [
        `TSHIRT-M,Acme tee M,pcs,1800,61091000,${GTIN},`,
        'ACME-ONLY,Acme only,pcs,1800,,ACME-ONLY-BC,',
        'ACME-COMP,Acme component,pcs,1800,,ACME-COMP-BC,',
        'ACME-KIT,Acme kit,pcs,1800,,ACME-KIT-BC,ACME-COMP:2',
        'ACME-SOLO,Acme solo,pcs,1800,,SHARED-SOLO-BC,',
        'ACME-FREE,Acme free,pcs,1800,,ACME-FREE-BC,',
      ],
      acme,
    );
    expect(acmeRun.body).toMatchObject({ committedRows: 6, failedRows: 0 });
    const betaRun = await importCsv(
      [
        `TSHIRT-M,Beta tee M,pcs,1800,62059000,${GTIN},`,
        'BETA-ONLY,Beta only,pcs,1800,,BETA-ONLY-BC,',
        // BETA holds ACME-COMP's CODE and another SKU holds ACME-SOLO's BARCODE.
        'ACME-COMP,Beta lookalike,pcs,1800,,BETA-LOOK-BC,',
        'BETA-SOLO,Beta solo,pcs,1800,,SHARED-SOLO-BC,',
      ],
      beta,
    );
    expect(betaRun.body).toMatchObject({ committedRows: 4, failedRows: 0 });
    await refreshSkus();

    const operator = await createMember('operator');
    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'PCS dock', pin: '2468' })
      .expect(201);
    deviceId = enrolled.body.device.id as string;
    const badged = await http()
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
      .send({ operatorEmail: operator.email, pin: '2468' })
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

  async function createClient(code: string, name: string): Promise<string> {
    const res = await http()
      .post(`${API}/${tenantId}/clients`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code, name })
      .expect(201);
    return res.body.client.id as string;
  }

  function importCsv(rows: string[], clientId: string): Promise<request.Response> {
    const csv = ['sku_code,name,uom,gst_rate,hsn,barcode,kit_components', ...rows].join('\n');
    return http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', clientId)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
  }

  function importCsvWith(header: string, rows: string[], clientId: string): Promise<request.Response> {
    return http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', clientId)
      .attach('file', Buffer.from([header, ...rows].join('\n'), 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
  }

  async function refreshSkus(): Promise<void> {
    const rows = (await sql`
      select s.id, s.code, c.code as client_code, c.system_owned
      from skus s join clients c on c.id = s.client_id
      where s.tenant_id = ${tenantId}
    `) as unknown as { id: string; code: string; client_code: string; system_owned: boolean }[];
    skuIds.clear();
    for (const row of rows) skuIds.set(`${row.system_owned ? 'SELF' : row.client_code}:${row.code}`, row.id);
  }

  async function createMember(role: 'ops_manager' | 'operator'): Promise<{ email: string }> {
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
    return { email };
  }

  async function newPo(skuId: string, orderedQty: number): Promise<{ poId: string; lineId: string }> {
    const res = await http()
      .post(`${API}/${tenantId}/inbound/purchase-orders`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, vendorId, code: `PO-${ulid().slice(14)}`, lines: [{ skuId, orderedQty, unitCostPaise: 100 }] })
      .expect(201);
    return { poId: res.body.purchaseOrder.id as string, lineId: res.body.purchaseOrder.lines[0].id as string };
  }

  function nowSecond(): string {
    return new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  }

  function line(skuId: string, qty: number, poLineId?: string): GrnLine {
    return { skuId, batchCode: null, mfgDate: null, qty, ...(poLineId === undefined ? {} : { poLineId }) };
  }

  function receive(body: GrnBody, key = ulid()): request.Test {
    return http()
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  /** A queued op reported by the device and re-applied by the owner (the sync-report path). */
  async function replayViaReview(body: Record<string, unknown>, opId = ulid()): Promise<request.Response> {
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
            attribution: { deviceLabel: 'PCS dock', operatorEmail: 'floor@example.com' },
            opEnqueuedAt: ENQUEUED_AT,
            opOccurredAt: null,
          },
        ],
      })
      .expect(201);
    const row = await rejectedOpByOpId(opId);
    return http()
      .post(`${API}/${tenantId}/rejected-ops/${row.id}/resolve`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ decision: 'apply' });
  }

  async function rejectedOpByOpId(opId: string): Promise<{ id: string; opId: string; opType: string; decisions: string[]; problemCode: string; payload: Record<string, unknown> }> {
    const listed = await http()
      .get(`${API}/${tenantId}/rejected-ops`)
      .query({ status: 'open', limit: 200 })
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const row = (listed.body.items as { id: string; opId: string; opType: string; decisions: string[]; problemCode: string; payload: Record<string, unknown> }[]).find(
      (item) => item.opId === opId,
    );
    if (row === undefined) throw new Error(`no open rejected op ${opId}`);
    return row;
  }

  async function grnClient(grnId: string): Promise<string | null> {
    const rows = (await sql`select client_id from goods_receipt_notes where id = ${grnId}`) as unknown as { client_id: string | null }[];
    return rows[0]?.client_id ?? null;
  }

  // ── catalog identity ───────────────────────────────────────────────────────

  describe('code and barcode are unique per client', () => {
    it('two clients both own TSHIRT-M under one GTIN; the per-tenant indexes are gone', async () => {
      const rows = (await sql`
        select client_id, barcode from skus where tenant_id = ${tenantId} and code = 'TSHIRT-M' order by client_id
      `) as unknown as { client_id: string; barcode: string }[];
      expect(rows.map((row) => row.client_id).sort()).toEqual([acme, beta].sort());
      expect(rows.every((row) => row.barcode === GTIN)).toBe(true);
      const indexes = (await sql`select indexname from pg_indexes where tablename = 'skus'`) as unknown as { indexname: string }[];
      const names = indexes.map((row) => row.indexname);
      expect(names).toEqual(expect.arrayContaining(['skus_tenant_client_code_unique', 'skus_tenant_client_barcode_unique', 'skus_tenant_code_idx']));
      expect(names).not.toContain('skus_tenant_id_code_unique');
      expect(names).not.toContain('skus_tenant_id_barcode_unique');
    });

    it('one client importing its own code or barcode twice is refused per row, naming this client\'s catalog', async () => {
      const res = await importCsv([`TSHIRT-M,Again,pcs,1800,,OTHER-BC,`, `NEW-ACME,New,pcs,1800,,${GTIN},`], acme);
      expect(res.body).toMatchObject({ committedRows: 0, failedRows: 2 });
      expect(res.body.errors).toEqual([
        expect.objectContaining({ skuCode: 'TSHIRT-M', code: 'duplicate-sku-code' }),
        expect.objectContaining({ skuCode: 'NEW-ACME', code: 'duplicate-barcode' }),
      ]);
      expect(res.body.errors[0].detail).toContain("already exists in this client's catalog (client ACME)");
      expect(res.body.errors[1].detail).toContain('SKU "TSHIRT-M"');
    });

    it('a direct duplicate within one client is refused by the per-client index; across clients it lands', async () => {
      await expect(
        sql`insert into skus (id, tenant_id, client_id, code, name, uom, gst_rate_bps, barcode)
            values (${uuidv7()}, ${tenantId}, ${acme}, 'TSHIRT-M', 'dup', 'each', 0, ${`X-${ulid()}`})`,
      ).rejects.toMatchObject({ code: '23505', constraint_name: 'skus_tenant_client_code_unique' });
      await expect(
        sql`insert into skus (id, tenant_id, client_id, code, name, uom, gst_rate_bps, barcode)
            values (${uuidv7()}, ${tenantId}, ${acme}, ${`X-${ulid()}`}, 'dup', 'each', 0, ${GTIN})`,
      ).rejects.toMatchObject({ code: '23505', constraint_name: 'skus_tenant_client_barcode_unique' });
    });

    it('a kit import naming a component code both clients hold composes over THIS client\'s SKU', async () => {
      // BETA also holds ACME-COMP (seeded); ACME's kit names it.
      const res = await importCsv(['ACME-KIT2,Acme kit two,pcs,1800,,ACME-KIT2-BC,ACME-COMP:1'], acme);
      expect(res.body).toMatchObject({ committedRows: 1, failedRows: 0 });
      await refreshSkus();
      const rows = (await sql`select component_sku_id from kit_compositions where tenant_id = ${tenantId} and kit_sku_id = ${sku('ACME', 'ACME-KIT2')}`) as unknown as { component_sku_id: string }[];
      expect(rows.map((row) => row.component_sku_id)).toEqual([sku('ACME', 'ACME-COMP')]);
    });

    it('SKU edit: another client\'s barcode is free; this client\'s is 409 duplicate-barcode', async () => {
      const patch = (skuId: string, barcode: string) =>
        http()
          .patch(`${API}/${tenantId}/catalog/skus/${skuId}`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ barcode });
      // ACME-ONLY's barcode belongs to ACME — BETA-ONLY may take it.
      await patch(sku('BETA', 'BETA-ONLY'), 'ACME-ONLY-BC').expect(200);
      // BETA's TSHIRT-M holds the GTIN — BETA-ONLY may not.
      const refused = await patch(sku('BETA', 'BETA-ONLY'), GTIN).expect(409);
      expect(refused.body).toMatchObject({ code: 'duplicate-barcode' });
      expect(refused.body.detail).toContain('SKU "TSHIRT-M"');
    });
  });

  // ── the client correction's collision check ────────────────────────────────

  describe('moving a SKU group to another client', () => {
    function correct(skuId: string, clientId: string) {
      return http()
        .post(`${API}/${tenantId}/catalog/skus/${skuId}/client`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ clientId });
    }

    it('a kit whose component\'s code the target client holds is 409 duplicate-sku-code; nothing moves', async () => {
      const res = await correct(sku('ACME', 'ACME-KIT'), beta).expect(409);
      expect(res.body).toMatchObject({ code: 'duplicate-sku-code' });
      expect(res.body.detail).toContain('"ACME-COMP"');
      expect(res.body.detail).toContain('client BETA');
      const rows = (await sql`select client_id from skus where id in ${sql([sku('ACME', 'ACME-KIT'), sku('ACME', 'ACME-COMP')])}`) as unknown as { client_id: string }[];
      expect(rows.every((row) => row.client_id === acme)).toBe(true);
    });

    it('a SKU whose barcode the target client holds is 409 duplicate-barcode', async () => {
      const res = await correct(sku('ACME', 'ACME-SOLO'), beta).expect(409);
      expect(res.body).toMatchObject({ code: 'duplicate-barcode' });
      expect(res.body.detail).toContain('SKU "BETA-SOLO"');
    });

    it('a colliding SKU committed between the check and the update maps the 23505 to 409, naming the holder', async () => {
      await importCsv(['ACME-RACE,Acme race,pcs,1800,,RACE-BC,'], acme);
      await refreshSkus();
      // A raw holder inserts BETA's colliding barcode and keeps its transaction
      // open: the correction's check cannot see it, its update then waits on
      // the unique index, and the holder's commit turns that wait into 23505.
      const holder = postgres(process.env.DATABASE_URL!, { max: 1 });
      try {
        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        const held = holder.begin(async (tx) => {
          await tx`insert into skus (id, tenant_id, client_id, code, name, uom, gst_rate_bps, barcode)
                   values (${uuidv7()}, ${tenantId}, ${beta}, 'BETA-RACE', 'race', 'each', 0, 'RACE-BC')`;
          await released;
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        const pending = correct(sku('ACME', 'ACME-RACE'), beta).then((res) => res);
        // Wait until the correction is parked on the index.
        for (let i = 0; i < 100; i += 1) {
          const waiting = (await sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`) as unknown as { n: number }[];
          if (waiting[0]!.n > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        release();
        await held;
        const res = await pending;
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'duplicate-barcode' });
        expect(res.body.detail).toContain('SKU "BETA-RACE" of client BETA');
        const moved = (await sql`select client_id from skus where id = ${sku('ACME', 'ACME-RACE')}`) as unknown as { client_id: string }[];
        expect(moved[0]!.client_id).toBe(acme);
      } finally {
        await holder.end();
      }
    });

    it('a SKU colliding with nothing moves', async () => {
      const res = await correct(sku('ACME', 'ACME-FREE'), beta).expect(200);
      expect(res.body.skus[0]).toMatchObject({ code: 'ACME-FREE', clientId: beta });
      await refreshSkus();
    });
  });

  // ── receiving: the GRN's client ────────────────────────────────────────────

  describe('the goods receipt names its client', () => {
    it('a PO receipt stamps the PO\'s client; another client\'s SKU still books unmatched to its own ledger (decision 4)', async () => {
      const { poId, lineId } = await newPo(sku('ACME', 'TSHIRT-M'), 10);
      const res = await receive({
        warehouseId: wh,
        poId,
        occurredAt: nowSecond(),
        lines: [line(sku('ACME', 'TSHIRT-M'), 2, lineId), line(sku('BETA', 'BETA-ONLY'), 1)],
      }).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt;
      expect(grn.clientId).toBe(acme);
      expect(await grnClient(grn.id)).toBe(acme);
      expect(grn.rejectedLines).toBeUndefined();
      expect(grn.unmatchedLines).toEqual([{ index: 1, reason: 'no-line-reference' }]);
      const events = (await sql`
        select client_id from ledger_events where tenant_id = ${tenantId} and reference_doc->>'grnId' = ${grn.id} and sku_id = ${sku('BETA', 'BETA-ONLY')}
      `) as unknown as { client_id: string }[];
      expect(events.map((event) => event.client_id)).toEqual([beta]);
    });

    it('a blind receipt for ACME refuses BETA\'s line PER LINE; the rest settles; one review row, Discard only', async () => {
      const key = ulid();
      const body: GrnBody = {
        warehouseId: wh,
        blindReasonCode: 'other',
        clientId: acme,
        occurredAt: nowSecond(),
        lines: [line(sku('ACME', 'TSHIRT-M'), 3), line(sku('BETA', 'TSHIRT-M'), 4)],
      };
      const res = await receive(body, key).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt;
      expect(grn.clientId).toBe(acme);
      expect(await grnClient(grn.id)).toBe(acme);
      expect(grn.lines.map((l) => [l.skuId, l.qty])).toEqual([[sku('ACME', 'TSHIRT-M'), 3]]);
      expect(grn.rejectedLines).toEqual([
        expect.objectContaining({ poLineId: null, skuId: sku('BETA', 'TSHIRT-M'), qty: 4, code: 'sku-client-mismatch' }),
      ]);
      expect(grn.rejectedLines![0]!.reason).toContain('client BETA');
      expect(grn.reviewOpId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(grn.reviewOpId).not.toBe(key);
      // BETA's units never reached the ledger.
      const betaEvents = (await sql`
        select 1 from ledger_events where tenant_id = ${tenantId} and reference_doc->>'grnId' = ${grn.id} and sku_id = ${sku('BETA', 'TSHIRT-M')}
      `) as unknown as unknown[];
      expect(betaEvents).toHaveLength(0);

      const review = await rejectedOpByOpId(grn.reviewOpId!);
      expect(review).toMatchObject({ opType: 'grn.lines-refused', decisions: ['discard'], problemCode: 'sku-client-mismatch' });
      expect(review.payload).toMatchObject({
        grnId: grn.id,
        clientId: acme,
        refusals: [expect.objectContaining({ lineIndex: 1, skuId: sku('BETA', 'TSHIRT-M'), skuCode: 'TSHIRT-M', skuClientId: beta, skuClientLabel: 'BETA' })],
      });
      const apply = await http()
        .post(`${API}/${tenantId}/rejected-ops/${review.id}/resolve`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ decision: 'apply' })
        .expect(409);
      expect(apply.body.code).toBe('decision-not-available');

      // A replay re-serves the stored body and raises nothing new.
      const replayed = await receive(body, key).expect(201);
      expect(replayed.body).toEqual(res.body);
      const reviewRows = (await sql`select count(*)::int as n from rejected_ops where tenant_id = ${tenantId} and op_id = ${grn.reviewOpId!}`) as unknown as { n: number }[];
      expect(reviewRows[0]!.n).toBe(1);

      await http()
        .post(`${API}/${tenantId}/rejected-ops/${review.id}/resolve`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ decision: 'discard' })
        .expect(200);
    });

    it('an older build\'s blind op (no clientId) is accepted byte-identically and stamps the derived client (golden)', async () => {
      const occurredAt = '2026-10-18T05:00:00.000Z';
      const key = ulid();
      const res = await receive(
        { warehouseId: wh, poId: null, blindReasonCode: 'other', occurredAt, lines: [line(sku('BETA', 'BETA-ONLY'), 1)] },
        key,
      ).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt;
      expect(grn.clientId).toBe(beta);
      expect(grn.rejectedLines).toBeUndefined();
      // The pre-1-1 fingerprint, written out key by key — no clientId. An
      // always-present `clientId: null` would fail here.
      const golden =
        `{"tenantId":"${tenantId}","deviceId":"${deviceId}","operatorUserId":"${operatorUserId}","warehouseId":"${wh}",` +
        `"poId":null,"blindReasonCode":"other","occurredAt":"${occurredAt}",` +
        `"lines":[{"poLineId":null,"skuId":"${sku('BETA', 'BETA-ONLY')}","batchCode":null,"mfgDate":null,"qty":1}]}`;
      const stored = (await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as { payload_hash: string }[];
      expect(stored[0]!.payload_hash).toBe(createHash('sha256').update(golden, 'utf8').digest('hex'));
    });

    it('a named client joins the fingerprint after blindReasonCode (golden)', async () => {
      const occurredAt = '2026-10-18T05:01:00.000Z';
      const key = ulid();
      await receive(
        { warehouseId: wh, poId: null, blindReasonCode: 'other', clientId: beta, occurredAt, lines: [line(sku('BETA', 'BETA-ONLY'), 1)] },
        key,
      ).expect(201);
      const golden =
        `{"tenantId":"${tenantId}","deviceId":"${deviceId}","operatorUserId":"${operatorUserId}","warehouseId":"${wh}",` +
        `"poId":null,"blindReasonCode":"other","clientId":"${beta}","occurredAt":"${occurredAt}",` +
        `"lines":[{"poLineId":null,"skuId":"${sku('BETA', 'BETA-ONLY')}","batchCode":null,"mfgDate":null,"qty":1}]}`;
      const stored = (await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as { payload_hash: string }[];
      expect(stored[0]!.payload_hash).toBe(createHash('sha256').update(golden, 'utf8').digest('hex'));
    });

    it('an older build\'s mixed blind op settles as before 1-1: every line books to its own client, nothing refused, the GRN client null (decision 7)', async () => {
      const res = await receive({
        warehouseId: wh,
        blindReasonCode: 'unannounced-delivery',
        occurredAt: nowSecond(),
        lines: [line(sku('ACME', 'ACME-ONLY'), 1), line(sku('BETA', 'BETA-ONLY'), 2), line(sku('ACME', 'TSHIRT-M'), 1)],
      }).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt;
      expect(grn.clientId).toBeUndefined();
      expect(await grnClient(grn.id)).toBeNull();
      expect(grn.rejectedLines).toBeUndefined();
      expect(grn.reviewOpId).toBeUndefined();
      expect(grn.lines.map((l) => l.skuId)).toEqual([sku('ACME', 'ACME-ONLY'), sku('BETA', 'BETA-ONLY'), sku('ACME', 'TSHIRT-M')]);
      const events = (await sql`
        select sku_id, client_id from ledger_events where tenant_id = ${tenantId} and reference_doc->>'grnId' = ${grn.id}
      `) as unknown as { sku_id: string; client_id: string }[];
      expect(new Map(events.map((e) => [e.sku_id, e.client_id]))).toEqual(
        new Map([
          [sku('ACME', 'ACME-ONLY'), acme],
          [sku('BETA', 'BETA-ONLY'), beta],
          [sku('ACME', 'TSHIRT-M'), acme],
        ]),
      );
    });

    it('a blind receipt whose EVERY line is another client\'s records no receipt; every line goes to review (decision 6)', async () => {
      const grnCount = async () =>
        ((await sql`select count(*)::int as n from goods_receipt_notes where tenant_id = ${tenantId}`) as unknown as { n: number }[])[0]!.n;
      const recordedEvents = async () =>
        ((await sql`select count(*)::int as n from outbox_messages where tenant_id = ${tenantId} and type = 'grn.recorded'`) as unknown as { n: number }[])[0]!.n;
      const before = await grnCount();
      const eventsBefore = await recordedEvents();
      const key = ulid();
      const body: GrnBody = {
        warehouseId: wh,
        blindReasonCode: 'other',
        clientId: acme,
        occurredAt: nowSecond(),
        lines: [line(sku('BETA', 'BETA-ONLY'), 2), line(sku('BETA', 'TSHIRT-M'), 1)],
      };
      const res = await receive(body, key).expect(201);
      expect(res.body.goodsReceipt).toBeNull();
      expect(res.body.refusedReceipt).toMatchObject({ warehouseId: wh, clientId: acme, blindReasonCode: 'other' });
      expect((res.body.refusedReceipt.rejectedLines as { skuId: string; qty: number; code: string }[]).map((l) => [l.skuId, l.qty, l.code])).toEqual([
        [sku('BETA', 'BETA-ONLY'), 2, 'sku-client-mismatch'],
        [sku('BETA', 'TSHIRT-M'), 1, 'sku-client-mismatch'],
      ]);
      expect(await grnCount()).toBe(before);
      expect(await recordedEvents()).toBe(eventsBefore);
      const review = await rejectedOpByOpId(res.body.refusedReceipt.reviewOpId as string);
      expect(review).toMatchObject({ opType: 'grn.lines-refused', decisions: ['discard'], problemCode: 'sku-client-mismatch' });
      expect(review.payload).toMatchObject({ grnId: null, grnCode: null, clientId: acme });
      expect((review.payload.refusals as unknown[]).length).toBe(2);
      // A replay re-serves the stored answer and records nothing.
      const replayed = await receive(body, key).expect(201);
      expect(replayed.body).toEqual(res.body);
      expect(await grnCount()).toBe(before);
      // No GRN code was consumed: the next receipt takes the next number.
      const maxRows = (await sql`select max(substring(code from '^GRN-([0-9]+)$')::int) as max from goods_receipt_notes where tenant_id = ${tenantId}`) as unknown as { max: number }[];
      const max = maxRows[0]!.max;
      const next = await receive({ warehouseId: wh, blindReasonCode: 'other', clientId: acme, occurredAt: nowSecond(), lines: [line(sku('ACME', 'ACME-ONLY'), 1)] }).expect(201);
      expect((next.body.goodsReceipt as GoodsReceipt).code).toBe(`GRN-${String(max + 1).padStart(4, '0')}`);
      await http()
        .post(`${API}/${tenantId}/rejected-ops/${review.id}/resolve`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ decision: 'discard' })
        .expect(200);
    });

    it('another client\'s line that would fail a per-line rule is refused per line, not the whole op; no batch is created for it', async () => {
      await importCsvWith('sku_code,name,uom,gst_rate,batch_tracked', ['BETA-LOT,Beta lot,pcs,1800,true'], beta);
      await refreshSkus();
      const res = await receive({
        warehouseId: wh,
        blindReasonCode: 'other',
        clientId: acme,
        occurredAt: nowSecond(),
        lines: [line(sku('ACME', 'ACME-ONLY'), 1), { skuId: sku('BETA', 'BETA-LOT'), batchCode: 'LOT-1', mfgDate: null, qty: 1.5 }],
      }).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt;
      expect(grn.lines.map((l) => l.skuId)).toEqual([sku('ACME', 'ACME-ONLY')]);
      expect(grn.rejectedLines!.map((l) => [l.skuId, l.qty, l.code])).toEqual([[sku('BETA', 'BETA-LOT'), 1.5, 'sku-client-mismatch']]);
      const batches = (await sql`select 1 from batches where tenant_id = ${tenantId} and sku_id = ${sku('BETA', 'BETA-LOT')}`) as unknown as unknown[];
      expect(batches).toHaveLength(0);
      await http()
        .post(`${API}/${tenantId}/rejected-ops/${(await rejectedOpByOpId(grn.reviewOpId!)).id}/resolve`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ decision: 'discard' })
        .expect(200);
    });

    // Story 1-2a decision 5 re-pinned this: a SUSPENDED client still ships and
    // receives — the receipt is no longer refused whole (was 409 client-not-active).
    it('a blind receipt naming a suspended client is accepted (decision 5) — its other-client line is refused per line', async () => {
      const gamma = await createClient('GAMMA', 'Gamma Goods');
      await http()
        .patch(`${API}/${tenantId}/clients/${gamma}/status`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ status: 'suspended' })
        .expect(200);
      const res = await receive({ warehouseId: wh, blindReasonCode: 'other', clientId: gamma, occurredAt: nowSecond(), lines: [line(sku('ACME', 'ACME-ONLY'), 1)] }).expect(201);
      expect(res.body.goodsReceipt).toBeNull();
      expect(res.body.refusedReceipt).toMatchObject({ clientId: gamma, rejectedLines: [expect.objectContaining({ code: 'sku-client-mismatch' })] });
    });

    it('a clientId beside a PO is 400; an unknown client is 404', async () => {
      const { poId, lineId } = await newPo(sku('ACME', 'ACME-ONLY'), 5);
      const paired = await receive({ warehouseId: wh, poId, clientId: acme, occurredAt: nowSecond(), lines: [line(sku('ACME', 'ACME-ONLY'), 1, lineId)] }).expect(400);
      expect(paired.body.code).toBe('validation-failed');
      const unknown = await receive({ warehouseId: wh, blindReasonCode: 'other', clientId: uuidv7(), occurredAt: nowSecond(), lines: [line(sku('ACME', 'ACME-ONLY'), 1)] }).expect(404);
      expect(unknown.body.code).toBe('not-found');
    });

    it('the sync-report re-apply carries the blind client through; an older stored payload derives it', async () => {
      const named = await replayViaReview({
        warehouseId: wh,
        blindReasonCode: 'other',
        clientId: beta,
        occurredAt: nowSecond(),
        lines: [line(sku('ACME', 'ACME-ONLY'), 1), line(sku('BETA', 'BETA-ONLY'), 1)],
      });
      expect(named.status).toBe(200);
      const namedGrn = named.body.outcome.snapshot.goodsReceipt as GoodsReceipt;
      expect(namedGrn.clientId).toBe(beta);
      expect(namedGrn.rejectedLines!.map((l) => [l.skuId, l.code])).toEqual([[sku('ACME', 'ACME-ONLY'), 'sku-client-mismatch']]);

      const legacy = await replayViaReview({
        warehouseId: wh,
        blindReasonCode: 'other',
        occurredAt: nowSecond(),
        lines: [{ skuId: sku('BETA', 'BETA-ONLY'), qty: 1 }],
      });
      expect(legacy.status).toBe(200);
      expect((legacy.body.outcome.snapshot.goodsReceipt as GoodsReceipt).clientId).toBe(beta);
    });

    it('a device cannot upload the server-raised review type', async () => {
      const res = await http()
        .post(`${API}/${tenantId}/devices/sync-reports`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          rows: [
            {
              opId: ulid(),
              opType: 'grn.lines-refused',
              classification: 'rejected',
              problemCode: 'sku-client-mismatch',
              problemDetail: null,
              payload: { warehouseId: wh, grnId: uuidv7(), grnCode: null, clientId: acme, lines: [], refusals: [] },
              attribution: { deviceLabel: 'PCS dock', operatorEmail: 'floor@example.com' },
              opEnqueuedAt: ENQUEUED_AT,
              opOccurredAt: null,
            },
          ],
        })
        .expect(400);
      expect(res.body.detail).toContain('grn.lines-refused');
    });

    it('every GRN this suite wrote carries a client, but the older build\'s mixed blind one (decision 7)', async () => {
      const rows = (await sql`select count(*)::int as n from goods_receipt_notes where tenant_id = ${tenantId} and client_id is null`) as unknown as { n: number }[];
      expect(rows[0]!.n).toBe(1);
      const all = (await sql`select count(*)::int as n from goods_receipt_notes where tenant_id = ${tenantId}`) as unknown as { n: number }[];
      expect(all[0]!.n).toBeGreaterThan(3);
      // The GRN list carries it too.
      const list = await http().get(`${API}/${tenantId}/receiving/goods-receipts`).query({ limit: 100 }).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      const listed = (list.body.items as { clientId?: string }[]).map((item) => item.clientId);
      expect(listed.filter((id) => id === undefined)).toHaveLength(1);
      expect(listed.every((id) => id === undefined || id === acme || id === beta)).toBe(true);
    });
  });

  // ── the device snapshot ────────────────────────────────────────────────────

  describe('the device catalog snapshot', () => {
    it('carries each SKU\'s client, the open documents\' clients, and the clients it names', async () => {
      const { poId } = await newPo(sku('BETA', 'TSHIRT-M'), 3);
      const res = await http()
        .get(`${API}/${tenantId}/devices/catalog-snapshot`)
        .query({ warehouseId: wh })
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);
      const tees = (res.body.skus as { id: string; code: string; barcode: string; clientId: string }[]).filter((s) => s.code === 'TSHIRT-M');
      expect(tees.map((s) => [s.id, s.clientId, s.barcode]).sort()).toEqual(
        [
          [sku('ACME', 'TSHIRT-M'), acme, GTIN],
          [sku('BETA', 'TSHIRT-M'), beta, GTIN],
        ].sort(),
      );
      const po = (res.body.openPurchaseOrders as { id: string; clientId: string }[]).find((p) => p.id === poId);
      expect(po?.clientId).toBe(beta);
      const clients = res.body.clients as { id: string; code: string; name: string; active: boolean }[];
      expect(clients).toEqual(
        expect.arrayContaining([
          { id: acme, code: 'ACME', name: 'Acme Apparel', active: true },
          { id: beta, code: 'BETA', name: 'Beta Brands', active: true },
        ]),
      );
      // Only referenced clients: the self client holds no SKU and no document here.
      expect(clients.map((c) => c.id)).not.toContain(selfClient);
    });
  });

  // ── the ASN import resolves codes within the ASN's client ─────────────────

  describe('the ASN import', () => {
    it('a blank-client row of an ASN naming ACME resolves to ACME\'s TSHIRT-M; a blank-only ASN of shared codes is client-required', async () => {
      const csv = [
        'asn_code,client,warehouse,expected_at,sku,quantity',
        'ASN-PCS-1,ACME,,,ACME-ONLY,1',
        'ASN-PCS-1,,,,TSHIRT-M,2',
        'ASN-PCS-2,,,,TSHIRT-M,1',
      ].join('\n');
      const res = await http()
        .post(`${API}/${tenantId}/inbound/asn-imports`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .field('warehouseId', wh)
        .attach('file', Buffer.from(csv, 'utf8'), { filename: 'asns.csv', contentType: 'text/csv' })
        .expect(201);
      expect(res.body.asns).toEqual([expect.objectContaining({ asnCode: 'ASN-PCS-1', clientId: acme, lineCount: 2 })]);
      expect(res.body.errors).toEqual([expect.objectContaining({ rowNumber: 4, asnCode: 'ASN-PCS-2', code: 'client-required' })]);
      expect(res.body.errors[0].detail).toContain('ACME');
      expect(res.body.errors[0].detail).toContain('BETA');
      const asnId = res.body.asns[0].asnId as string;
      const lines = (await sql`select sku_id from asn_lines where asn_id = ${asnId} order by created_at, id`) as unknown as { sku_id: string }[];
      expect(lines.map((row) => row.sku_id).sort()).toEqual([sku('ACME', 'ACME-ONLY'), sku('ACME', 'TSHIRT-M')].sort());
    });
  });

  // ── the HSN hint by SKU ────────────────────────────────────────────────────

  describe('the HSN summary hint', () => {
    it('reads each issue line\'s hint from its OWN SKU when two clients share the code', async () => {
      // Two issued blank-HSN lines, one on each client's TSHIRT-M (raw rows:
      // the hint is a read concern; the order line → SKU link is what counts).
      const invoiceId = uuidv7();
      const acmeLine = uuidv7();
      const betaLine = uuidv7();
      await sql`insert into order_lines (id, tenant_id, order_id, sku_id, qty) values
        (${acmeLine}, ${tenantId}, ${uuidv7()}, ${sku('ACME', 'TSHIRT-M')}, 1000),
        (${betaLine}, ${tenantId}, ${uuidv7()}, ${sku('BETA', 'TSHIRT-M')}, 1000)`;
      const document = {
        header: { invoiceNo: '29/2627/000901', fyLabel: 'FY-2627', orderRef: uuidv7(), issuedAt: '2026-09-15T12:00:00.000Z', originGstin: G29, consigneeGstin: null },
        lines: [
          { orderLineId: acmeLine, skuCode: 'TSHIRT-M', hsn: null, uom: 'each' },
          { orderLineId: betaLine, skuCode: 'TSHIRT-M', hsn: null, uom: 'each' },
        ],
        totals: { subtotal: 2000, gst: 360, total: 2360, roundOff: 40, payable: 2400 },
        gaps: [],
        revision: 1,
      };
      await sql`
        insert into invoices (id, tenant_id, order_id, warehouse_id, invoice_no, fy_label, series_seq, status, origin_gstin,
          consignee_gstin, place_of_supply, supply_type, subtotal_paise, gst_paise, total_paise, payable_paise, round_off_paise,
          revision, document, issued_at)
        values (${invoiceId}, ${tenantId}, ${uuidv7()}, ${wh}, '29/2627/000901', 'FY-2627', 901, 'issued', ${G29}, null, '29', 'intra',
          2000, 360, 2360, 2400, 40, 1, ${sql.json(document as never)}, '2026-09-15T12:00:00.000Z'::timestamptz)
      `;
      for (const [orderLineId, taxable] of [[acmeLine, 1000], [betaLine, 1000]] as const) {
        await sql`
          insert into invoice_lines (id, tenant_id, invoice_id, order_line_id, sku_code, sku_name, hsn, qty_milli, rate_paise,
            rate_source, taxable_paise, gst_bps, cgst_paise, sgst_paise, igst_paise, hsn_gap, uom)
          values (${uuidv7()}, ${tenantId}, ${invoiceId}, ${orderLineId}, 'TSHIRT-M', 'Tee', null, 1000, 0, 'manual',
            ${taxable}, 1800, 90, 90, 0, true, 'each')
        `;
      }
      const summary = await app.get(InvoicingFacade).hsnSummary(tenantId, G29, '2026-09');
      expect(summary.issueLines.map((issue) => issue.catalogHsn).sort()).toEqual(['61091000', '62059000']);
    });
  });

  // ── refusal labels ─────────────────────────────────────────────────────────

  describe('codes in refusals are labelled with their client', () => {
    it('a multi-client tenant reads CODE (client); the self client reads as the company', async () => {
      const db = app.get<Database>(DATABASE);
      const labels = await withTenantTransaction(db, tenantId, (tx) =>
        skuCodeLabelsInTx(tx, tenantId, [
          { code: 'TSHIRT-M', clientId: acme },
          { code: 'TSHIRT-M', clientId: beta },
          { code: 'TSHIRT-M', clientId: acme },
          { code: 'OWN', clientId: selfClient },
        ]),
      );
      expect(labels).toEqual(['TSHIRT-M (ACME)', 'TSHIRT-M (BETA)', `OWN (${tenantName} (your company))`]);
    });
  });
});

// ── migration 0076, applied to pre-migration data ────────────────────────────

describe('migration 0076: the index swap, the GRN client backfill and its probes', () => {
  const PRE_DB = 'wms_s_pcsku_premigration';
  let baseUrl: string;
  let sql: ReturnType<typeof postgres>;
  let folder: string;
  const notices: string[] = [];

  const tenantId = uuidv7();
  const clientA = uuidv7();
  const clientB = uuidv7();
  const skuA = uuidv7();
  const skuA2 = uuidv7();
  const skuB = uuidv7();
  const grnSingle = uuidv7();
  const grnMixed = uuidv7();
  const grnEmpty = uuidv7();
  const poId = uuidv7();
  const asnId = uuidv7();
  const grnPoMixed = uuidv7();
  const grnAsnEmpty = uuidv7();

  function migrationStatements(): string[] {
    return readFileSync(resolve(process.cwd(), 'drizzle/0076_per_client_sku_identity.sql'), 'utf8')
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
  }

  async function applyMigration(): Promise<void> {
    await sql.begin(async (tx) => {
      for (const statement of migrationStatements()) {
        await tx.unsafe(statement);
      }
    });
  }

  beforeAll(async () => {
    baseUrl = process.env.DATABASE_URL!;
    const url = new URL(baseUrl);
    url.pathname = `/${PRE_DB}`;
    const preUrl = url.toString();
    const adminUrl = new URL(baseUrl);
    adminUrl.pathname = '/postgres';
    const admin = postgres(adminUrl.toString(), { max: 1 });
    try {
      await admin.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PRE_DB}'`);
      await admin.unsafe(`drop database if exists "${PRE_DB}"`);
      await admin.unsafe(`create database "${PRE_DB}"`);
    } finally {
      await admin.end();
    }

    // The repo's own migrations, stopped at 0075 — the schema the moment
    // before this story.
    folder = mkdtempSync(join(tmpdir(), 'wms-pre-0076-'));
    cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
    rmSync(join(folder, '0076_per_client_sku_identity.sql'));
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 75);
    writeFileSync(journalPath, JSON.stringify(journal));
    const db = createDatabase(preUrl);
    await migrate(db, { migrationsFolder: folder });
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();

    sql = postgres(preUrl, { max: 2, onnotice: (notice) => notices.push(String(notice.message)) });

    // Pre-migration rows: three SKUs (two of A, one of B), and three GRNs —
    // single-client lines, mixed-client lines, no lines.
    await sql`insert into skus (id, tenant_id, client_id, code, name, uom, gst_rate_bps, barcode) values
      (${skuA}, ${tenantId}, ${clientA}, 'A-1', 'a1', 'each', 0, 'BC-A-1'),
      (${skuA2}, ${tenantId}, ${clientA}, 'A-2', 'a2', 'each', 0, 'BC-A-2'),
      (${skuB}, ${tenantId}, ${clientB}, 'B-1', 'b1', 'each', 0, 'BC-B-1')`;
    for (const [id, code] of [[grnSingle, 'GRN-0001'], [grnMixed, 'GRN-0002'], [grnEmpty, 'GRN-0003']] as const) {
      await sql`insert into goods_receipt_notes (id, tenant_id, warehouse_id, code, blind_reason_code, device_id, recorded_by, occurred_at, recorded_at)
        values (${id}, ${tenantId}, ${tenantId}, ${code}, 'other', ${tenantId}, ${tenantId}, now(), now())`;
    }
    // Decision 5 — document receipts take the document's client: a PO receipt
    // of client B whose lines mix A and B (a 21-6 unmatched line), and a
    // line-less ASN receipt of client A.
    await sql`insert into purchase_orders (id, tenant_id, client_id, warehouse_id, vendor_id, code) values (${poId}, ${tenantId}, ${clientB}, ${tenantId}, ${tenantId}, 'PO-0076')`;
    await sql`insert into advance_shipment_notices (id, tenant_id, client_id, warehouse_id, asn_code) values (${asnId}, ${tenantId}, ${clientA}, ${tenantId}, 'ASN-0076')`;
    await sql`insert into goods_receipt_notes (id, tenant_id, warehouse_id, code, po_id, device_id, recorded_by, occurred_at, recorded_at)
      values (${grnPoMixed}, ${tenantId}, ${tenantId}, 'GRN-0004', ${poId}, ${tenantId}, ${tenantId}, now(), now())`;
    await sql`insert into goods_receipt_notes (id, tenant_id, warehouse_id, code, asn_id, device_id, recorded_by, occurred_at, recorded_at)
      values (${grnAsnEmpty}, ${tenantId}, ${tenantId}, 'GRN-0005', ${asnId}, ${tenantId}, ${tenantId}, now(), now())`;
    await sql`insert into goods_receipt_lines (id, tenant_id, grn_id, sku_id, qty, applied_qty) values
      (${uuidv7()}, ${tenantId}, ${grnPoMixed}, ${skuA}, 1000, 1000),
      (${uuidv7()}, ${tenantId}, ${grnPoMixed}, ${skuB}, 1000, 1000)`;
    await sql`insert into goods_receipt_lines (id, tenant_id, grn_id, sku_id, qty, applied_qty) values
      (${uuidv7()}, ${tenantId}, ${grnSingle}, ${skuA}, 1000, 1000),
      (${uuidv7()}, ${tenantId}, ${grnSingle}, ${skuA2}, 1000, 1000),
      (${uuidv7()}, ${tenantId}, ${grnMixed}, ${skuA}, 1000, 1000),
      (${uuidv7()}, ${tenantId}, ${grnMixed}, ${skuB}, 1000, 1000)`;

    await applyMigration();
  });

  afterAll(async () => {
    await sql?.end();
    rmSync(folder, { recursive: true, force: true });
    const adminUrl = new URL(baseUrl);
    adminUrl.pathname = '/postgres';
    const admin = postgres(adminUrl.toString(), { max: 1 });
    try {
      await admin.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PRE_DB}'`);
      await admin.unsafe(`drop database if exists "${PRE_DB}"`);
    } finally {
      await admin.end();
    }
  });

  it('backfills document receipts from their document, a single-client blind GRN from its lines; leaves mixed and line-less blind ones null and lists them', async () => {
    const rows = (await sql`select id, client_id from goods_receipt_notes where tenant_id = ${tenantId}`) as unknown as { id: string; client_id: string | null }[];
    const byId = new Map(rows.map((row) => [row.id, row.client_id]));
    expect(byId.get(grnSingle)).toBe(clientA);
    expect(byId.get(grnMixed)).toBeNull();
    expect(byId.get(grnEmpty)).toBeNull();
    // Decision 5: the document's client, whatever the lines say.
    expect(byId.get(grnPoMixed)).toBe(clientB);
    expect(byId.get(grnAsnEmpty)).toBe(clientA);
    const notice = notices.find((message) => message.startsWith('migration 0076:'));
    expect(notice).toBeDefined();
    expect(notice).toContain('2 goods receipt(s) left without a client');
    expect(notice).toContain('GRN-0002');
    expect(notice).toContain('GRN-0003');
  });

  it('changes no SKU row, and swaps the indexes', async () => {
    const skus = (await sql`select id, client_id, code, barcode from skus where tenant_id = ${tenantId} order by code`) as unknown as { id: string; client_id: string; code: string; barcode: string }[];
    expect(skus).toEqual([
      { id: skuA, client_id: clientA, code: 'A-1', barcode: 'BC-A-1' },
      { id: skuA2, client_id: clientA, code: 'A-2', barcode: 'BC-A-2' },
      { id: skuB, client_id: clientB, code: 'B-1', barcode: 'BC-B-1' },
    ]);
    const indexes = (await sql`select indexname from pg_indexes where tablename = 'skus'`) as unknown as { indexname: string }[];
    const names = indexes.map((row) => row.indexname);
    expect(names).toEqual(expect.arrayContaining(['skus_tenant_client_code_unique', 'skus_tenant_client_barcode_unique', 'skus_tenant_code_idx']));
    expect(names).not.toContain('skus_tenant_id_code_unique');
    expect(names).not.toContain('skus_tenant_id_barcode_unique');
    // Across clients the same code lands; within one it does not.
    await sql`insert into skus (id, tenant_id, client_id, code, name, uom, gst_rate_bps, barcode) values (${uuidv7()}, ${tenantId}, ${clientB}, 'A-1', 'b-a1', 'each', 0, 'BC-A-1')`;
    await expect(
      sql`insert into skus (id, tenant_id, client_id, code, name, uom, gst_rate_bps, barcode) values (${uuidv7()}, ${tenantId}, ${clientA}, 'A-1', 'dup', 'each', 0, 'BC-NEW')`,
    ).rejects.toMatchObject({ code: '23505', constraint_name: 'skus_tenant_client_code_unique' });
  });

  it('refuses to run twice (the fail-fast guard)', async () => {
    // The index statements are not idempotent either; the guard is what a
    // re-run of the DATA statements would meet first, so prove it directly.
    const guard = migrationStatements().find((statement) => statement.includes('the backfill has run'))!;
    await expect(sql.unsafe(guard)).rejects.toMatchObject({ message: expect.stringContaining('already stamped') });
  });
});
