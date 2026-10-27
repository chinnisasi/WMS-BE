import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { Database } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { ReceivingFacade } from '../src/modules/inbound/receiving.facade';
import { getLedgerEventType } from '../src/modules/inventory/ledger-registry';
import { ensureInTransitBinInTx } from '../src/modules/tenancy/receiving-bin';
import {
  GRN_LINE_SERIAL_STATES,
  MAX_GRN_SERIALS_PER_LINE,
  SERIAL_FORMATS,
  isValidImei,
} from '../src/shared/primitives/serial';
import {
  LINES_REFUSED_CODE_PRECEDENCE,
  REJECTED_GRN_LINE_CODES,
} from '../src/modules/inbound/receiving.command';
import type { SignedQuantity } from '../src/shared/primitives/quantity';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';
import { createLinkedVendor, linkVendor } from './support/linked-vendor';
import { expectAuditRow } from './support/audit-guard';

// Story 2-6a — serial / IMEI capture at receipt: `grn.submit` carries
// `lines[].serials` (one per good unit) and `unreadableSerialQty`; the
// server books one `grn.received` per applied serial, stores every captured
// unit as a `goods_receipt_line_serials` row, refuses per line
// (`serials-required` / `serials-on-untracked`) or per serial (the six
// serial codes, `serialsOnly`), carries pending serials through the
// over-receipt approval, and hands the putaway task its serials. Every
// frozen and amended I/O row, the goldens, approve / reject (incl. the 409),
// the raw re-apply hash, the shelf-life Apply, identity creation, the audit
// row, chain / projection parity and the putaway tasks.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;

jest.setTimeout(180_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const OCCURRED_AT = '2026-10-24T04:30:00.000Z';

interface GrnLine {
  poLineId?: string | null;
  asnLineId?: string | null;
  skuId: string;
  batchCode: string | null;
  mfgDate: string | null;
  expiryDate?: string;
  qty: number;
  serials?: string[] | null;
  unreadableSerialQty?: number;
  damagedQty?: number;
  damageReasonCode?: string;
}

interface GrnLineSnapshot {
  id: string;
  grnId: string;
  skuId: string;
  batchId: string | null;
  qty: number;
  appliedQty: number;
  excessQty: number;
  serials?: string[];
  pendingSerials?: string[];
  unreadableSerialQty?: number;
  qcSkipped?: string;
}

interface Rejected {
  code: string;
  index?: number;
  qty: number;
  serials?: string[];
  serialsOnly?: true;
  serialDetails?: { serial: string; binCode?: string; warehouseCode?: string; skuCode?: string }[];
  reason: string;
}

interface GoodsReceipt {
  id: string;
  code: string;
  lines: GrnLineSnapshot[];
  rejectedLines?: Rejected[];
  reviewOpId?: string;
  shelfLifeReviewOpId?: string;
  qcSkippedLines?: number;
}

describe('story 2-6a: serial / IMEI capture at receipt (e2e)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let db: Database;
  let inventory: InventoryFacade;

  let tenantId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let wh: string;
  let whCode: string;
  let storageBin: string;
  let storageBin2: string;
  let vendorId: string;
  let deviceId: string;
  let operatorToken: string;
  let operatorUserId: string;
  const clientIds = new Map<string, string>();
  const skuIds = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const client = (code: string): string => clientIds.get(code)!;
  const sku = (code: string): string => {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  };
  /** A fresh, unique serial number. */
  const sn = (prefix = 'SN'): string => `${prefix}-${ulid().slice(10)}`;
  /** A fresh, Luhn-valid IMEI (15 digits). */
  const imei = (): string => {
    const body = `35${String(Date.now()).slice(-8)}${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;
    for (let digit = 0; digit < 10; digit += 1) if (isValidImei(`${body}${digit}`)) return `${body}${digit}`;
    throw new Error('unreachable');
  };

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('serial_receipt');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });
    db = app.get<Database>(DATABASE);
    inventory = app.get(InventoryFacade);

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `SR Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    const signedIn = await mintSignIn(app, { email, password: 'correct-horse-battery' });
    ownerToken = signedIn.body.accessToken as string;
    ownerUserId = (await sql`select id from users where email = ${email}`)[0]!.id as string;

    ({ id: wh, code: whCode } = await createWarehouse('SR'));
    storageBin = await createBin(wh, 'A', 'A-01');
    storageBin2 = await createBin(wh, 'B', 'B-01');
    vendorId = await createLinkedVendor(app, tenantId, ownerToken, { code: 'V-SR', name: 'SR Vendor' });

    for (const [code, name] of [
      ['PLAIN', 'Plain Brand'],
      ['QC', 'QC Brand'],
      ['EXP', 'Expiry Brand'],
    ] as const) {
      clientIds.set(code, await createClient(code, name));
    }
    // code, uom, batch, serial
    await importSkus('PLAIN', [
      ['S', false, true],
      ['S2', false, true],
      ['P1', false, true],
      ['P2', false, true],
      ['U', false, false],
      ['OLD', false, false],
    ]);
    await importSkus('QC', [['QS', false, true]]);
    await importSkus('EXP', [['BS', true, true]]);
    await patchSku(sku('P1'), { serialFormat: 'imei' }).expect(200);
    await patchSku(sku('P2'), { serialFormat: 'imei' }).expect(200);

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
      .send({ code: minted.body.code, label: 'SR dock', pin: '2468' })
      .expect(201);
    deviceId = enrolled.body.device.id as string;
    const badged = await http()
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
      .send({ operatorEmail: operator.email, pin: '2468' })
      .expect(200);
    operatorToken = badged.body.accessToken as string;
    operatorUserId = badged.body.operator.id as string;

    await setPolicy('QC', { receivingToleranceBps: 0, qcOnReceipt: true, expiryRequired: false, minShelfLifeDays: null });
    await setPolicy('EXP', { receivingToleranceBps: 0, qcOnReceipt: false, expiryRequired: true, minShelfLifeDays: 90 });
  });

  afterAll(async () => {
    await sql?.end();
    const appDb = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await appDb.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function createWarehouse(prefix: string): Promise<{ id: string; code: string }> {
    const code = `${prefix}-${ulid().slice(20)}`;
    const id = (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code, name: `${prefix} warehouse` })
        .expect(201)
    ).body.id as string;
    return { id, code };
  }

  async function createBin(warehouseId: string, zoneCode: string, binCode: string): Promise<string> {
    const zone = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: zoneCode, name: `Zone ${zoneCode}` })
        .expect(201)
    ).body.id as string;
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 100000, type: 'shelf', code: binCode })
        .expect(201)
    ).body.id as string;
  }

  async function createClient(code: string, name: string): Promise<string> {
    const res = await http()
      .post(`${API}/${tenantId}/clients`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code, name })
      .expect(201);
    await linkVendor(app, tenantId, ownerToken, vendorId, res.body.client.id as string);
    return res.body.client.id as string;
  }

  async function importSkus(clientCode: string, rows: readonly (readonly [string, boolean, boolean])[]): Promise<void> {
    const csv = [
      'sku_code,name,uom,gst_rate,barcode,batch_tracked,serial_tracked,catch_weight_tracked',
      ...rows.map(([code, batch, serial]) => `${code},${code} name,pcs,1800,${clientCode}-${code}-BC,${batch},${serial},false`),
    ].join('\n');
    const res = await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', client(clientCode))
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    expect(res.body).toMatchObject({ committedRows: rows.length, failedRows: 0 });
    const stored = (await sql`select id, code from skus where tenant_id = ${tenantId} and client_id = ${client(clientCode)}`) as unknown as {
      id: string;
      code: string;
    }[];
    for (const row of stored) skuIds.set(row.code, row.id);
  }

  function patchSku(skuId: string, body: Record<string, unknown>): request.Test {
    return http()
      .patch(`${API}/${tenantId}/catalog/skus/${skuId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send(body);
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

  async function setPolicy(
    clientCode: string,
    policy: { receivingToleranceBps: number; qcOnReceipt: boolean; expiryRequired: boolean; minShelfLifeDays: number | null },
  ): Promise<void> {
    await http()
      .put(`${API}/${tenantId}/clients/${client(clientCode)}/receiving-policy`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send(policy)
      .expect(200);
  }

  async function newPo(skuId: string, orderedQty: number, warehouseId = wh): Promise<{ poId: string; lineId: string }> {
    const res = await http()
      .post(`${API}/${tenantId}/inbound/purchase-orders`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, vendorId, code: `PO-${ulid().slice(14)}`, lines: [{ skuId, orderedQty, unitCostPaise: 100 }] })
      .expect(201);
    return { poId: res.body.purchaseOrder.id as string, lineId: res.body.purchaseOrder.lines[0].id as string };
  }

  function line(skuId: string, serials: string[] | null, extra: Partial<GrnLine> = {}): GrnLine {
    return { skuId, batchCode: null, mfgDate: null, qty: serials?.length ?? 1, ...(serials === null ? {} : { serials }), ...extra };
  }

  function receive(body: Record<string, unknown>, key = ulid(), warehouseId = wh): request.Test {
    return http()
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId, occurredAt: OCCURRED_AT, ...body });
  }

  function blind(clientCode: string, lines: GrnLine[], extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { poId: null, blindReasonCode: 'other', clientId: client(clientCode), lines, ...extra };
  }

  async function received(body: Record<string, unknown>, key = ulid(), warehouseId = wh): Promise<GoodsReceipt> {
    const res = await receive(body, key, warehouseId).expect(201);
    return res.body.goodsReceipt as GoodsReceipt;
  }

  async function serialId(skuId: string, number: string): Promise<string | undefined> {
    const rows = (await sql`select id from serials where tenant_id = ${tenantId} and sku_id = ${skuId} and serial_number = ${number}`) as unknown as { id: string }[];
    return rows[0]?.id;
  }

  async function serialEvents(skuId: string, number: string): Promise<{ type: string; quantity_delta: string; warehouse_id: string; to_bin_id: string | null }[]> {
    const id = await serialId(skuId, number);
    if (id === undefined) return [];
    return (await sql`
      select type, quantity_delta::text as quantity_delta, warehouse_id, to_bin_id from ledger_events
      where tenant_id = ${tenantId} and serial_ref = ${id} order by id`) as never;
  }

  async function rowsOf(grnLineId: string): Promise<{ ordinal: number; serial_id: string | null; state: string; over_receipt_id: string | null; after_write_off: boolean }[]> {
    return (await sql`
      select ordinal, serial_id, state, over_receipt_id, after_write_off from goods_receipt_line_serials
      where tenant_id = ${tenantId} and grn_line_id = ${grnLineId} order by ordinal`) as never;
  }

  async function receivingBin(warehouseId = wh): Promise<string> {
    const rows = (await sql`select id from bins where tenant_id = ${tenantId} and warehouse_id = ${warehouseId} and code = 'RECEIVING' and system_owned`) as unknown as { id: string }[];
    return rows[0]!.id;
  }

  /** A raw ledger append of one serial unit (a pick, a write-off, a transfer leg the suite needs as history). */
  async function appendSerialEvent(args: {
    warehouseId?: string;
    type: string;
    skuId: string;
    serialRef: string;
    quantityDelta: number;
    fromBinId: string | null;
    toBinId: string | null;
  }): Promise<void> {
    const definition = getLedgerEventType(args.type)!;
    await withTenantTransaction(db, tenantId, (tx) =>
      inventory.appendLedgerEventInTx(tx, {
        tenantId,
        warehouseId: args.warehouseId ?? wh,
        type: args.type,
        skuId: args.skuId,
        quantityDelta: args.quantityDelta as SignedQuantity,
        fromBinId: args.fromBinId,
        toBinId: args.toBinId,
        batchRef: null,
        serialRef: args.serialRef,
        actorUserId: ownerUserId,
        occurredAt: OCCURRED_AT,
        recordedAt: new Date().toISOString(),
        referenceDoc: { kind: definition.referenceKinds[0] } as never,
      }),
    );
  }

  async function rejectedOp(opId: string): Promise<{ id: string; type: string; problem_code: string; problem_detail: string; payload: Record<string, unknown> }> {
    const rows = (await sql`select id, op_type as type, problem_code, problem_detail, payload from rejected_ops where tenant_id = ${tenantId} and op_id = ${opId}`) as unknown as {
      id: string;
      type: string;
      problem_code: string;
      problem_detail: string;
      payload: Record<string, unknown>;
    }[];
    return rows[0]!;
  }

  function decide(overReceiptId: string, decision: 'approve' | 'reject', key = ulid()): request.Test {
    return http()
      .post(`${API}/${tenantId}/receiving/over-receipts/${overReceiptId}/${decision}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, key)
      .send();
  }

  async function overReceiptOf(grnId: string): Promise<string> {
    const rows = (await sql`select id from over_receipts where tenant_id = ${tenantId} and grn_id = ${grnId}`) as unknown as { id: string }[];
    return rows[0]!.id;
  }

  async function linesRead(grnId: string): Promise<Record<string, unknown>[]> {
    const res = await http()
      .get(`${API}/${tenantId}/receiving/goods-receipts/${grnId}/lines`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    return res.body.items as Record<string, unknown>[];
  }

  function storedHash(key: string): Promise<string> {
    return (sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}` as unknown as Promise<{ payload_hash: string }[]>).then(
      (rows) => rows[0]!.payload_hash,
    );
  }

  // ── the vocabularies, the caps, the migration's CHECKs ─────────────────────

  describe('vocabularies', () => {
    it('the 8 serial codes join the per-line vocabulary and the precedence, after every older code', () => {
      expect([...REJECTED_GRN_LINE_CODES].slice(-8)).toEqual([
        'serials-required',
        'serials-on-untracked',
        'serial-format-invalid',
        'serial-in-stock',
        'serial-in-transit',
        'serial-pending-approval',
        'serial-dispatched-use-returns',
        'serial-blocked',
      ]);
      expect([...LINES_REFUSED_CODE_PRECEDENCE].slice(0, 6)).toEqual([
        'client-departed',
        'sku-client-mismatch',
        'batch-expiry-mismatch',
        'expiry-before-mfg',
        'expiry-on-untracked',
        'expiry-required',
      ]);
      // In order (code review C17): line-level first, then the serial codes;
      // the web's guidance mirrors this order.
      expect([...LINES_REFUSED_CODE_PRECEDENCE].slice(6)).toEqual([
        'serials-required',
        'serials-on-untracked',
        'serial-in-stock',
        'serial-in-transit',
        'serial-pending-approval',
        'serial-dispatched-use-returns',
        'serial-blocked',
        'serial-format-invalid',
      ]);
      expect(getLedgerEventType('grn.received')).toMatchObject({ allowsSerialArm: true });
      expect(getLedgerEventType('grn.damaged')).toMatchObject({ allowsSerialArm: false });
      expect(getLedgerEventType('qc.held')).toMatchObject({ allowsSerialArm: false });
      expect(getLedgerEventType('qc.released')).toMatchObject({ allowsSerialArm: false });
    });

    it('the TS tuples and caps match the 0096 CHECK literals', async () => {
      const defs = (await sql`
        select conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conname in ('skus_serial_format_check', 'grls_state_check', 'grls_ordinal_range')`) as unknown as { conname: string; def: string }[];
      const def = (name: string): string => defs.find((row) => row.conname === name)!.def;
      for (const format of SERIAL_FORMATS) expect(def('skus_serial_format_check')).toContain(`'${format}'::text`);
      expect(def('skus_serial_format_check').match(/'[a-z]+'::text/g)).toHaveLength(SERIAL_FORMATS.length);
      for (const state of GRN_LINE_SERIAL_STATES) expect(def('grls_state_check')).toContain(`'${state}'::text`);
      expect(def('grls_state_check').match(/'[a-z]+'::text/g)).toHaveLength(GRN_LINE_SERIAL_STATES.length);
      // ordinal 0..499 ⇔ 500 serial rows per line.
      expect(def('grls_ordinal_range')).toContain(`<= ${MAX_GRN_SERIALS_PER_LINE - 1}`);
      expect(def('grls_ordinal_range')).toContain('>= 0');
    });

    it('goods_receipt_line_serials is tenant-isolated under RLS (wms_rls_probe)', async () => {
      const grn = await received(blind('PLAIN', [line(sku('S'), [sn()])]));
      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const rls = postgres(url.toString(), { max: 1 });
      try {
        const count = (stamp: string): Promise<number> =>
          rls.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${stamp}, true)`;
            const rows = await tx`select count(*)::int as n from goods_receipt_line_serials where grn_id = ${grn.id}`;
            return Number(rows[0]!.n);
          }) as Promise<number>;
        expect(await count(tenantId)).toBe(1);
        expect(await count(uuidv7())).toBe(0);
      } finally {
        await rls.end();
      }
    });
  });

  // ── the goldens ─────────────────────────────────────────────────────────────

  describe('the hash and the snapshot (goldens)', () => {
    it('(a) a serial line hashes `serials` after the line keys, as sent (literal golden)', async () => {
      const occurredAt = '2026-10-24T05:00:00.000Z';
      const [a, b] = [sn('G'), sn('G')];
      const key = ulid();
      await receive(blind('PLAIN', [line(sku('S'), [a, b])], { occurredAt }), key).expect(201);
      const golden =
        `{"tenantId":"${tenantId}","deviceId":"${deviceId}","operatorUserId":"${operatorUserId}","warehouseId":"${wh}",` +
        `"poId":null,"blindReasonCode":"other","clientId":"${client('PLAIN')}","occurredAt":"${occurredAt}",` +
        `"lines":[{"poLineId":null,"skuId":"${sku('S')}","batchCode":null,"mfgDate":null,"qty":2,"serials":["${a}","${b}"]}]}`;
      expect(await storedHash(key)).toBe(createHash('sha256').update(golden, 'utf8').digest('hex'));
      // With unreadable units: the key follows `serials`.
      const c = sn('G');
      const key2 = ulid();
      await receive(blind('PLAIN', [line(sku('S'), [c], { unreadableSerialQty: 2 })], { occurredAt }), key2).expect(201);
      const golden2 =
        `{"tenantId":"${tenantId}","deviceId":"${deviceId}","operatorUserId":"${operatorUserId}","warehouseId":"${wh}",` +
        `"poId":null,"blindReasonCode":"other","clientId":"${client('PLAIN')}","occurredAt":"${occurredAt}",` +
        `"lines":[{"poLineId":null,"skuId":"${sku('S')}","batchCode":null,"mfgDate":null,"qty":1,"serials":["${c}"],"unreadableSerialQty":2}]}`;
      expect(await storedHash(key2)).toBe(createHash('sha256').update(golden2, 'utf8').digest('hex'));
    });

    it('(b) `serials: []`, `serials: null` and `unreadableSerialQty: 0` hash as the line without either key', async () => {
      const occurredAt = '2026-10-24T05:10:00.000Z';
      const golden =
        `{"tenantId":"${tenantId}","deviceId":"${deviceId}","operatorUserId":"${operatorUserId}","warehouseId":"${wh}",` +
        `"poId":null,"blindReasonCode":"other","clientId":"${client('PLAIN')}","occurredAt":"${occurredAt}",` +
        `"lines":[{"poLineId":null,"skuId":"${sku('OLD')}","batchCode":null,"mfgDate":null,"qty":1}]}`;
      const digest = createHash('sha256').update(golden, 'utf8').digest('hex');
      for (const extra of [{}, { serials: [] }, { serials: null }, { unreadableSerialQty: 0 }, { serials: [], unreadableSerialQty: 0 }]) {
        const key = ulid();
        await receive(blind('PLAIN', [{ skuId: sku('OLD'), batchCode: null, mfgDate: null, qty: 1, ...extra }], { occurredAt }), key).expect(201);
        expect([extra, await storedHash(key)]).toEqual([extra, digest]);
      }
    });

    it('(c) a line without serials has its pre-2-6a snapshot keys and writes no serial row', async () => {
      const key = ulid();
      const grn = await received(blind('PLAIN', [line(sku('OLD'), null, { qty: 2 })]), key);
      expect(Object.keys(grn.lines[0]!)).toEqual(['id', 'grnId', 'poLineId', 'skuId', 'batchId', 'batchCode', 'qty', 'appliedQty', 'excessQty']);
      const stored = (await sql`select response_snapshot::text as s from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as { s: string }[];
      expect(stored[0]!.s).not.toMatch(/serials|pendingSerials|qcSkipped|unreadableSerialQty/);
      expect(Number((await sql`select count(*)::int as n from goods_receipt_line_serials where grn_id = ${grn.id}`)[0]!.n)).toBe(0);
    });
  });

  // ── booking ─────────────────────────────────────────────────────────────────

  describe('booking per unit', () => {
    it('open PO of 3, serials [A,B,C]: three grn.received +1 with their serial refs; rows applied; credit 3; the web lists them', async () => {
      const { poId, lineId } = await newPo(sku('S'), 3);
      const [a, b, c] = [sn(), sn(), sn()];
      const grn = await received({ poId, lines: [line(sku('S'), [a, b, c], { poLineId: lineId })] });
      expect(grn.lines[0]).toMatchObject({ qty: 3, appliedQty: 3, excessQty: 0, serials: [a, b, c] });
      expect(grn.lines[0]!.pendingSerials).toBeUndefined();
      for (const serial of [a, b, c]) {
        const events = await serialEvents(sku('S'), serial);
        expect(events).toEqual([{ type: 'grn.received', quantity_delta: '1000', warehouse_id: wh, to_bin_id: await receivingBin() }]);
      }
      const rows = await rowsOf(grn.lines[0]!.id);
      expect(rows.map((row) => [row.ordinal, row.state, row.over_receipt_id, row.after_write_off])).toEqual([
        [0, 'applied', null, false],
        [1, 'applied', null, false],
        [2, 'applied', null, false],
      ]);
      expect(rows.map((row) => row.serial_id)).toEqual([await serialId(sku('S'), a), await serialId(sku('S'), b), await serialId(sku('S'), c)]);
      expect(Number((await sql`select received_qty from purchase_order_lines where id = ${lineId}`)[0]!.received_qty)).toBe(3000);
      const lines = await linesRead(grn.id);
      expect(lines[0]).toMatchObject({ serials: [a, b, c].map((serial) => ({ serial, state: 'applied' })) });
      // Chain and projections stay in parity with the per-unit events.
      const verified = await inventory.verifyChain(tenantId, wh);
      expect(verified).toMatchObject({ ok: true });
      const rebuilt = await inventory.rebuildProjections(tenantId, wh);
      expect(rebuilt.divergences).toEqual([]);
      expect(rebuilt.repaired).toEqual([]);
    });

    it('excess: open 2, [A,B,C] → A,B book, C pends; the review lists C; approve books C (row applied)', async () => {
      const { poId, lineId } = await newPo(sku('S'), 2);
      const [a, b, c] = [sn(), sn(), sn()];
      const grn = await received({ poId, lines: [line(sku('S'), [a, b, c], { poLineId: lineId })] });
      expect(grn.lines[0]).toMatchObject({ qty: 3, appliedQty: 2, excessQty: 1, serials: [a, b], pendingSerials: [c] });
      const overReceiptId = await overReceiptOf(grn.id);
      const rows = await rowsOf(grn.lines[0]!.id);
      expect(rows.map((row) => [row.state, row.over_receipt_id])).toEqual([
        ['applied', null],
        ['applied', null],
        ['pending', overReceiptId],
      ]);
      expect(await serialEvents(sku('S'), c)).toEqual([]);
      const list = await http()
        .get(`${API}/${tenantId}/receiving/over-receipts?status=pending`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect((list.body.items as { id: string; serials?: string[] }[]).find((item) => item.id === overReceiptId)).toMatchObject({ serials: [c] });
      expect((await linesRead(grn.id))[0]).toMatchObject({
        serials: [
          { serial: a, state: 'applied' },
          { serial: b, state: 'applied' },
          { serial: c, state: 'pending' },
        ],
      });

      const key = ulid();
      const approved = await decide(overReceiptId, 'approve', key).expect(200);
      expect(approved.body.overReceipt).toMatchObject({ status: 'approved', serials: [c] });
      expect((await serialEvents(sku('S'), c)).map((event) => [event.type, event.quantity_delta])).toEqual([['grn.received', '1000']]);
      expect((await rowsOf(grn.lines[0]!.id)).map((row) => row.state)).toEqual(['applied', 'applied', 'applied']);
      expect(Number((await sql`select received_qty from purchase_order_lines where id = ${lineId}`)[0]!.received_qty)).toBe(3000);
      // A same-key replay re-serves the answer and appends nothing.
      await decide(overReceiptId, 'approve', key).expect(200);
      expect(await serialEvents(sku('S'), c)).toHaveLength(1);
    });

    it('excess: C booked elsewhere first → approve answers 409 serial-in-stock naming C and its bin; C stays pending; reject marks it rejected', async () => {
      const { poId, lineId } = await newPo(sku('S'), 1);
      const [a, c] = [sn(), sn()];
      const grn = await received({ poId, lines: [line(sku('S'), [a, c], { poLineId: lineId })] });
      const overReceiptId = await overReceiptOf(grn.id);
      // C cannot be received again while it pends (A5) …
      const other = await received(blind('PLAIN', [line(sku('S'), [c, sn()])]));
      expect(other.rejectedLines).toEqual([expect.objectContaining({ code: 'serial-pending-approval', serials: [c], serialsOnly: true })]);
      // … but a raw intake (an adjustment, a found unit) can still land it.
      const cId = (await sql`select serial_id from goods_receipt_line_serials where grn_line_id = ${grn.lines[0]!.id} and ordinal = 1`)[0]!.serial_id as string;
      await appendSerialEvent({ type: 'stock.adjusted', skuId: sku('S'), serialRef: cId, quantityDelta: 1000, fromBinId: null, toBinId: storageBin });
      const refused = await decide(overReceiptId, 'approve').expect(409);
      expect(refused.body.code).toBe('serial-in-stock');
      expect(refused.body.detail).toContain(`"${c}"`);
      expect(refused.body.detail).toContain('A-01');
      expect((await rowsOf(grn.lines[0]!.id)).map((row) => row.state)).toEqual(['applied', 'pending']);
      const rejected = await decide(overReceiptId, 'reject').expect(200);
      expect(rejected.body.overReceipt).toMatchObject({ status: 'rejected', serials: [c] });
      expect((await rowsOf(grn.lines[0]!.id)).map((row) => row.state)).toEqual(['applied', 'rejected']);
      expect((await linesRead(grn.id))[0]).toMatchObject({ serials: [{ serial: a, state: 'applied' }, { serial: c, state: 'rejected' }] });
    });

    it('a terminal document (a closed PO, no successor): every serial pends; the approval books them in order', async () => {
      const { poId, lineId } = await newPo(sku('S'), 5);
      await http()
        .post(`${API}/${tenantId}/inbound/purchase-orders/${poId}/close`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ lines: [{ lineId, disposition: 'cancelled' }] })
        .expect(200);
      const [a, b] = [sn(), sn()];
      const grn = await received({ poId, lines: [line(sku('S'), [a, b], { poLineId: lineId })] });
      expect(grn.lines[0]).toMatchObject({ appliedQty: 0, excessQty: 2, pendingSerials: [a, b] });
      expect(grn.lines[0]!.serials).toBeUndefined();
      await decide(await overReceiptOf(grn.id), 'approve').expect(200);
      const ids = [await serialId(sku('S'), a), await serialId(sku('S'), b)];
      const events = (await sql`
        select serial_ref from ledger_events where tenant_id = ${tenantId} and type = 'grn.received' and serial_ref in ${sql(ids as string[])} order by id`) as unknown as { serial_ref: string }[];
      expect(events.map((event) => event.serial_ref)).toEqual(ids);
    });

    it('a legacy excess (no serial rows — pre-2-6a) approves anonymously, as before', async () => {
      const { poId, lineId } = await newPo(sku('S'), 1);
      const grn = await received({ poId, lines: [line(sku('S'), [sn(), sn()], { poLineId: lineId })] });
      await sql`delete from goods_receipt_line_serials where grn_line_id = ${grn.lines[0]!.id}`;
      const overReceiptId = await overReceiptOf(grn.id);
      const approved = await decide(overReceiptId, 'approve').expect(200);
      expect(approved.body.overReceipt.serials).toBeUndefined();
      const events = (await sql`
        select quantity_delta::text as q, serial_ref from ledger_events
        where tenant_id = ${tenantId} and type = 'grn.received' and reference_doc->>'grnId' = ${grn.id} and serial_ref is null`) as unknown as { q: string; serial_ref: null }[];
      expect(events).toEqual([{ q: '1000', serial_ref: null }]);
    });

    it('unreadable: [A] + 1 unreadable → A books (qty 1); one unreadable row; the web shows the count', async () => {
      const a = sn();
      const grn = await received(blind('PLAIN', [line(sku('S'), [a], { unreadableSerialQty: 1 })]));
      expect(grn.lines[0]).toMatchObject({ qty: 1, appliedQty: 1, serials: [a], unreadableSerialQty: 1 });
      expect((await rowsOf(grn.lines[0]!.id)).map((row) => [row.ordinal, row.state, row.serial_id === null])).toEqual([
        [0, 'applied', false],
        [1, 'unreadable', true],
      ]);
      expect((await linesRead(grn.id))[0]).toMatchObject({ unreadableSerialQty: 1, serials: [{ serial: a, state: 'applied' }] });
    });

    it('QC on receipt: a serial line books UNHELD and says so (response and lines read)', async () => {
      const grn = await received(blind('QC', [line(sku('QS'), [sn()])]));
      expect(grn.lines[0]).toMatchObject({ appliedQty: 1, qcSkipped: 'serial-tracked' });
      expect(grn.qcSkippedLines).toBe(1);
      expect((await linesRead(grn.id))[0]).toMatchObject({ qcSkipped: 'serial-tracked' });
    });
  });

  // ── refusals ────────────────────────────────────────────────────────────────

  describe('refusals', () => {
    it('duplicate in stock: [A,B,C] with B in stock → A, C book (qty 2, credit 2); B refused serialsOnly naming its bin; one review row', async () => {
      const b = sn();
      await received(blind('PLAIN', [line(sku('S'), [b])]));
      const { poId, lineId } = await newPo(sku('S'), 3);
      const [a, c] = [sn(), sn()];
      const grn = await received({ poId, lines: [line(sku('S'), [a, b, c], { poLineId: lineId })] });
      expect(grn.lines[0]).toMatchObject({ qty: 2, appliedQty: 2, serials: [a, c] });
      expect(grn.rejectedLines).toEqual([
        expect.objectContaining({
          code: 'serial-in-stock',
          index: 0,
          qty: 1,
          serials: [b],
          serialsOnly: true,
          serialDetails: [{ serial: b, binCode: 'RECEIVING', warehouseCode: whCode }],
        }),
      ]);
      expect(grn.rejectedLines![0]!.reason).toContain(`"${b}" at RECEIVING (${whCode})`);
      expect(Number((await sql`select received_qty from purchase_order_lines where id = ${lineId}`)[0]!.received_qty)).toBe(2000);
      const row = await rejectedOp(grn.reviewOpId!);
      expect(row).toMatchObject({ type: 'grn.lines-refused', problem_code: 'serial-in-stock' });
      expect(row.problem_detail).toBe(
        `1 serial unit(s) of goods receipt "${grn.code}" were not booked (1 already in stock). The rest of each line booked. Each entry names its serials — check the units, then discard this review.`,
      );
      expect(row.payload.lines).toEqual([expect.objectContaining({ skuId: sku('S'), qty: 1, serials: [b] })]);
      expect((row.payload.refusals as Record<string, unknown>[])[0]).toMatchObject({ reason: 'serial-in-stock', serials: [b], serialsOnly: true });
    });

    it('two devices offline: the second receipt books T only and refuses S naming the first one\'s bin', async () => {
      const [s, t] = [sn(), sn()];
      await received(blind('PLAIN', [line(sku('S'), [s])]));
      const second = await received(blind('PLAIN', [line(sku('S'), [s, t])]));
      expect(second.lines[0]).toMatchObject({ serials: [t] });
      expect(second.rejectedLines).toEqual([expect.objectContaining({ code: 'serial-in-stock', serials: [s], serialsOnly: true })]);
      expect(Number((await sql`select count(*)::int as n from rejected_ops where tenant_id = ${tenantId} and op_id = ${second.reviewOpId!}`)[0]!.n)).toBe(1);
    });

    it('every line refused → {goodsReceipt: null, refusedReceipt}; no GRN code is consumed', async () => {
      const s = sn();
      await received(blind('PLAIN', [line(sku('S'), [s])]));
      const before = Number((await sql`select count(*)::int as n from goods_receipt_notes where tenant_id = ${tenantId}`)[0]!.n);
      const res = await receive(blind('PLAIN', [line(sku('S'), [s])])).expect(201);
      expect(res.body.goodsReceipt).toBeNull();
      expect(res.body.refusedReceipt.rejectedLines).toEqual([expect.objectContaining({ code: 'serial-in-stock', serials: [s] })]);
      expect(res.body.refusedReceipt.rejectedLines[0].serialsOnly).toBeUndefined();
      const row = await rejectedOp(res.body.refusedReceipt.reviewOpId as string);
      expect(row.problem_detail).toBe(
        'No goods receipt was recorded — 1 serial unit(s) were not booked (1 already in stock). 1 line(s) were refused whole. Each entry names its serials — check the units, then discard this review.',
      );
      expect(Number((await sql`select count(*)::int as n from goods_receipt_notes where tenant_id = ${tenantId}`)[0]!.n)).toBe(before);
    });

    it('after a pick (pick.picked) → serial-dispatched-use-returns', async () => {
      const s = sn();
      await received(blind('PLAIN', [line(sku('S'), [s])]));
      await appendSerialEvent({ type: 'pick.picked', skuId: sku('S'), serialRef: (await serialId(sku('S'), s))!, quantityDelta: -1000, fromBinId: await receivingBin(), toBinId: null });
      const res = await receive(blind('PLAIN', [line(sku('S'), [s])])).expect(201);
      expect(res.body.refusedReceipt.rejectedLines[0]).toMatchObject({ code: 'serial-dispatched-use-returns', serials: [s] });
      expect(res.body.refusedReceipt.rejectedLines[0].reason).toContain('receive them as a return');
    });

    it('after a write-off (a negative stock.adjusted) → books; after_write_off; one serial_re_received audit row', async () => {
      const s = sn();
      await received(blind('PLAIN', [line(sku('S'), [s])]));
      await appendSerialEvent({ type: 'stock.adjusted', skuId: sku('S'), serialRef: (await serialId(sku('S'), s))!, quantityDelta: -1000, fromBinId: await receivingBin(), toBinId: null });
      const key = ulid();
      const grn = await received(blind('PLAIN', [line(sku('S'), [s])]), key);
      expect(grn.lines[0]).toMatchObject({ appliedQty: 1, serials: [s] });
      expect((await rowsOf(grn.lines[0]!.id))[0]).toMatchObject({ state: 'applied', after_write_off: true });
      expect((await linesRead(grn.id))[0]).toMatchObject({ serials: [{ serial: s, state: 'applied', afterWriteOff: true }] });
      const alongside = [{ action: 'goods_receipt.submitted', targetType: 'goods_receipt', targetId: grn.id, actorUserId: operatorUserId }];
      await expectAuditRow({ tenantId, key, action: 'goods_receipt.serial_re_received', targetType: 'goods_receipt', targetId: grn.id, actorUserId: operatorUserId, alongside });
      // A same-key replay writes nothing more.
      await receive(blind('PLAIN', [line(sku('S'), [s])]), key).expect(201);
      await expectAuditRow({ tenantId, key, action: 'goods_receipt.serial_re_received', targetType: 'goods_receipt', targetId: grn.id, actorUserId: operatorUserId, alongside });
    });

    it('in transit (transfer.outbound) → serial-in-transit', async () => {
      const s = sn();
      await received(blind('PLAIN', [line(sku('S'), [s])]));
      const inTransit = await withTenantTransaction(db, tenantId, (tx) => ensureInTransitBinInTx(tx, tenantId, wh));
      await appendSerialEvent({
        type: 'transfer.outbound',
        skuId: sku('S'),
        serialRef: (await serialId(sku('S'), s))!,
        quantityDelta: 1000,
        fromBinId: await receivingBin(),
        toBinId: (inTransit as { binId: string }).binId,
      });
      const res = await receive(blind('PLAIN', [line(sku('S'), [s])])).expect(201);
      expect(res.body.refusedReceipt.rejectedLines[0]).toMatchObject({ code: 'serial-in-transit', serials: [s] });
    });

    it('A2: after a cross-warehouse transfer (the destination\'s seq is lower), the serial is in stock — never booked again', async () => {
      const { id: whB } = await createWarehouse('SRB');
      const binB = await createBin(whB, 'Z', 'Z-01');
      const s = sn();
      // Raise warehouse A's seq well above B's.
      for (let i = 0; i < 3; i += 1) await received(blind('PLAIN', [line(sku('OLD'), null, { qty: 1 })]));
      await received(blind('PLAIN', [line(sku('S'), [s])]));
      const id = (await serialId(sku('S'), s))!;
      const inTransitA = (await withTenantTransaction(db, tenantId, (tx) => ensureInTransitBinInTx(tx, tenantId, wh))) as { binId: string };
      await appendSerialEvent({ type: 'transfer.outbound', skuId: sku('S'), serialRef: id, quantityDelta: 1000, fromBinId: await receivingBin(), toBinId: inTransitA.binId });
      // The cross-warehouse inbound: a draw on the source chain, an intake on the destination's.
      await appendSerialEvent({ type: 'transfer.inbound', skuId: sku('S'), serialRef: id, quantityDelta: -1000, fromBinId: inTransitA.binId, toBinId: null });
      await appendSerialEvent({ warehouseId: whB, type: 'transfer.inbound', skuId: sku('S'), serialRef: id, quantityDelta: 1000, fromBinId: null, toBinId: binB });
      const seqs = (await sql`select warehouse_id, seq from ledger_events where tenant_id = ${tenantId} and serial_ref = ${id} order by id`) as unknown as { warehouse_id: string; seq: number }[];
      // The precondition the defect needs: the latest event (by id) has the LOWER seq.
      expect(Number(seqs.at(-1)!.seq)).toBeLessThan(Number(seqs.at(-2)!.seq));
      const res = await receive(blind('PLAIN', [line(sku('S'), [s])])).expect(201);
      expect(res.body.refusedReceipt.rejectedLines[0]).toMatchObject({ code: 'serial-in-stock', serials: [s], serialDetails: [expect.objectContaining({ binCode: 'Z-01' })] });
      // The history reads in append order across the two warehouses.
      const history = await inventory.serialHistory(tenantId, id);
      expect(history.map((entry) => [entry.type, entry.warehouseId])).toEqual([
        ['grn.received', wh],
        ['transfer.outbound', wh],
        ['transfer.inbound', wh],
        ['transfer.inbound', whB],
      ]);
      expect(await inventory.serialLocation(tenantId, id)).toEqual({ warehouseId: whB, binId: binB });
      // The append guard reads the same latest event (code review C15): a
      // second intake anywhere is refused, a draw from B's bin succeeds.
      await expect(
        appendSerialEvent({ type: 'stock.adjusted', skuId: sku('S'), serialRef: id, quantityDelta: 1000, fromBinId: null, toBinId: storageBin }),
      ).rejects.toThrow(`is already located in bin "${binB}"`);
      await appendSerialEvent({ warehouseId: whB, type: 'stock.adjusted', skuId: sku('S'), serialRef: id, quantityDelta: -1000, fromBinId: binB, toBinId: null });
    });

    it('serial blocked → serial-blocked', async () => {
      const s = sn();
      await received(blind('PLAIN', [line(sku('S'), [s])]));
      const id = (await serialId(sku('S'), s))!;
      await appendSerialEvent({ type: 'stock.adjusted', skuId: sku('S'), serialRef: id, quantityDelta: -1000, fromBinId: await receivingBin(), toBinId: null });
      await sql`update serials set status = 'blocked' where id = ${id}`;
      const res = await receive(blind('PLAIN', [line(sku('S'), [s])])).expect(201);
      expect(res.body.refusedReceipt.rejectedLines[0]).toMatchObject({ code: 'serial-blocked', serials: [s] });
    });

    it('missing serials (an old build or queued op) → serials-required for that line; the other lines book', async () => {
      const grn = await received(blind('PLAIN', [{ skuId: sku('S'), batchCode: null, mfgDate: null, qty: 2 }, line(sku('OLD'), null, { qty: 1 })]));
      expect(grn.lines).toHaveLength(1);
      expect(grn.lines[0]).toMatchObject({ skuId: sku('OLD') });
      expect(grn.rejectedLines).toEqual([expect.objectContaining({ code: 'serials-required', index: 0, qty: 2 })]);
      expect(grn.rejectedLines![0]!.serials).toBeUndefined();
      const row = await rejectedOp(grn.reviewOpId!);
      expect(row.problem_code).toBe('serials-required');
    });

    it('serials on an untracked SKU → serials-on-untracked; the serials create no identity', async () => {
      const x = sn('UN');
      const res = await receive(blind('PLAIN', [line(sku('U'), [x])])).expect(201);
      expect(res.body.refusedReceipt.rejectedLines[0]).toMatchObject({ code: 'serials-on-untracked', serials: [x] });
      expect(Number((await sql`select count(*)::int as n from serials where tenant_id = ${tenantId} and serial_number = ${x}`)[0]!.n)).toBe(0);
    });

    it('IMEI: a valid IMEI books; an invalid one is refused serial-format-invalid (serialsOnly) and creates no identity', async () => {
      const valid = '490154203237518';
      const invalid = '490154203237517';
      const grn = await received(blind('PLAIN', [line(sku('P1'), [valid, invalid])]));
      expect(grn.lines[0]).toMatchObject({ qty: 1, serials: [valid] });
      expect(grn.rejectedLines).toEqual([expect.objectContaining({ code: 'serial-format-invalid', serials: [invalid], serialsOnly: true })]);
      expect(await serialId(sku('P1'), invalid)).toBeUndefined();
    });

    it('A7: the same IMEI in stock under imei SKU P1 is refused on imei SKU P2 naming P1; P2\'s other serials book', async () => {
      const held = '352099001761481';
      const other = '356938035643809';
      await received(blind('PLAIN', [line(sku('P1'), [held])]));
      const grn = await received(blind('PLAIN', [line(sku('P2'), [held, other])]));
      expect(grn.lines[0]).toMatchObject({ serials: [other] });
      expect(grn.rejectedLines).toEqual([
        expect.objectContaining({ code: 'serial-in-stock', serials: [held], serialDetails: [expect.objectContaining({ serial: held, skuCode: 'P1' })] }),
      ]);
      expect(await serialId(sku('P2'), held)).toBeUndefined();
    });

    it('a free-format number on two SKUs is two units (both book)', async () => {
      const s = sn('TWIN');
      await received(blind('PLAIN', [line(sku('S'), [s])]));
      const grn = await received(blind('PLAIN', [line(sku('S2'), [s])]));
      expect(grn.lines[0]).toMatchObject({ serials: [s] });
      expect(grn.rejectedLines).toBeUndefined();
    });

    it('the shape: each a whole-op 400 above the transaction (a used key is never replayed)', async () => {
      const key = ulid();
      await receive(blind('PLAIN', [line(sku('S'), [sn()])]), key).expect(201);
      const bad: [string, GrnLine[]][] = [
        ['count ≠ qty', [line(sku('S'), [sn(), sn()], { qty: 3 })]],
        ['blank', [line(sku('S'), ['   '])]],
        ['65 characters', [line(sku('S'), ['x'.repeat(65)])]],
        ['whitespace inside', [line(sku('S'), ['SN 1'])]],
        ['repeat within a SKU', [line(sku('S'), ['DUP-1']), line(sku('S'), ['DUP-1'])]],
        ['unreadable only', [{ skuId: sku('S'), batchCode: null, mfgDate: null, qty: 0, unreadableSerialQty: 1 }]],
        ['over 500 per line (with unreadable)', [line(sku('S'), Array.from({ length: 499 }, (_, i) => `L-${i}`), { unreadableSerialQty: 2 })]],
        ['over 1,000 per receipt', [0, 1, 2].map((block) => line(sku('S'), Array.from({ length: 400 }, (_, i) => `R-${block}-${i}`)))],
      ];
      for (const [label, lines] of bad) {
        const res = await receive(blind('PLAIN', lines), key);
        expect([label, res.status, res.body.code]).toEqual([label, 400, 'validation-failed']);
      }
      // 64 characters and a trimmed value are fine.
      const trimmed = await received(blind('PLAIN', [line(sku('S'), [`  ${'y'.repeat(60)}${ulid().slice(22)}  `])]));
      expect(trimmed.lines[0]!.serials![0]).toHaveLength(64);
    });

    it('damage on a serial line stays a 400', async () => {
      const res = await receive(blind('PLAIN', [line(sku('S'), [sn()], { damagedQty: 1, damageReasonCode: 'crushed' })])).expect(400);
      expect(res.body.detail).toContain('serial-tracked');
    });
  });

  // ── re-apply and review rows ───────────────────────────────────────────────

  describe('re-apply and the review rows', () => {
    it('A13: the stored payload re-applied RAW (the sync-report rebuild) hashes as the original op — it replays', async () => {
      const key = ulid();
      const serials = [sn(), ` ${sn()}`];
      const first = await receive(blind('PLAIN', [line(sku('S'), serials)]), key).expect(201);
      const receiving = app.get(ReceivingFacade);
      const replayed = await receiving.submitGoodsReceipt(
        {
          tenantId,
          deviceId,
          operatorUserId,
          warehouseId: wh,
          poId: null,
          blindReasonCode: 'other',
          clientId: client('PLAIN'),
          occurredAt: OCCURRED_AT,
          lines: [{ poLineId: null, skuId: sku('S'), batchCode: null, mfgDate: null, qty: 2, serials } as never],
        },
        key,
      );
      expect(replayed).toEqual(first.body);
    });

    it('a shelf-life-refused serial line carries its serials; the Apply books them', async () => {
      const [a, b] = [sn(), sn()];
      const res = await receive(blind('EXP', [line(sku('BS'), [a, b], { batchCode: 'B-SL', expiryDate: '2026-11-01' })])).expect(201);
      const opId = res.body.refusedReceipt.shelfLifeReviewOpId as string;
      const row = await rejectedOp(opId);
      expect((row.payload.lines as Record<string, unknown>[])[0]).toMatchObject({ qty: 2, serials: [a, b] });
      expect(await serialId(sku('BS'), a)).toBeUndefined();
      const applied = await http()
        .post(`${API}/${tenantId}/rejected-ops/${row.id}/resolve`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ decision: 'apply', note: 'short-dated, accepted' })
        .expect(200);
      const snapshot = (applied.body.outcome as { snapshot: { goodsReceipt: GoodsReceipt } }).snapshot.goodsReceipt;
      expect(snapshot.lines[0]).toMatchObject({ qty: 2, appliedQty: 2, serials: [a, b] });
      expect((await serialEvents(sku('BS'), a)).map((event) => event.type)).toEqual(['grn.received']);
    });
  });

  // ── putaway ─────────────────────────────────────────────────────────────────

  describe('putaway (A14)', () => {
    async function snapshotTasks(): Promise<{ grnLineId: string; qty: number; serialNumbers?: string[] }[]> {
      const res = await http()
        .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${wh}`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);
      return res.body.putawayTasks as never;
    }

    function place(grn: GoodsReceipt, lineIndex: number, serials: string[], toBinId = storageBin2): request.Test {
      const target = grn.lines[lineIndex]!;
      return http()
        .post(`${API}/${tenantId}/putaway/placements`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId: wh,
          grnId: grn.id,
          grnLineId: target.id,
          skuId: target.skuId,
          batchId: target.batchId,
          qty: serials.length,
          toBinId,
          reasonCode: 'operator-preference',
          occurredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
          serials,
        });
    }

    it('the snapshot carries serialFormat and each serial task its serials; placing line 1 in full leaves line 2 unchanged', async () => {
      const res = await http()
        .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${wh}`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);
      const skus = res.body.skus as { id: string; serialFormat: string }[];
      expect(skus.find((entry) => entry.id === sku('P1'))!.serialFormat).toBe('imei');
      expect(skus.find((entry) => entry.id === sku('S'))!.serialFormat).toBe('free');

      const one = [sn('PA'), sn('PA')];
      const two = [sn('PB'), sn('PB'), sn('PB')];
      const grn = await received(blind('PLAIN', [line(sku('S2'), one), line(sku('S2'), two)]));
      const before = await snapshotTasks();
      expect(before.find((task) => task.grnLineId === grn.lines[0]!.id)).toMatchObject({ qty: 2, serialNumbers: one });
      expect(before.find((task) => task.grnLineId === grn.lines[1]!.id)).toMatchObject({ qty: 3, serialNumbers: two });
      await place(grn, 0, one).expect(201);
      const after = await snapshotTasks();
      expect(after.find((task) => task.grnLineId === grn.lines[0]!.id)).toBeUndefined();
      expect(after.find((task) => task.grnLineId === grn.lines[1]!.id)).toMatchObject({ qty: 3, serialNumbers: two });
      // Placed: the serial's history ends at the storage bin.
      expect((await serialEvents(sku('S2'), one[0]!)).map((event) => [event.type, event.to_bin_id])).toEqual([
        ['grn.received', await receivingBin()],
        ['putaway.placed', storageBin2],
      ]);
      // A partial placement shrinks the task to the serials still in Receiving.
      const partial = await place(grn, 1, [two[1]!]);
      expect([partial.status, partial.body.detail]).toEqual([201, undefined]);
      expect((await snapshotTasks()).find((task) => task.grnLineId === grn.lines[1]!.id)).toMatchObject({ qty: 2, serialNumbers: [two[0], two[2]] });
    });
  });

  // ── the SKU's serial format ─────────────────────────────────────────────────

  describe('code review additions', () => {
    it('C3: the same IMEI on lines of two imei SKUs in ONE receipt books once; the later line refuses it naming the first SKU', async () => {
      const shared = imei();
      const grn = await received(blind('PLAIN', [line(sku('P1'), [shared]), line(sku('P2'), [shared, imei()])]));
      expect(grn.lines.map((entry) => entry.serials)).toEqual([[shared], [expect.any(String)]]);
      expect(grn.rejectedLines).toEqual([
        expect.objectContaining({ index: 1, code: 'serial-in-stock', serials: [shared], serialDetails: [{ serial: shared, skuCode: 'P1' }] }),
      ]);
      expect(await serialId(sku('P2'), shared)).toBeUndefined();
    });

    it('C1: approving an imei excess whose IMEI is now in stock under ANOTHER imei SKU is a 409 naming that SKU', async () => {
      const { poId, lineId } = await newPo(sku('P2'), 1);
      const [first, extra] = [imei(), imei()];
      const grn = await received({ poId, lines: [line(sku('P2'), [first, extra], { poLineId: lineId })] });
      expect(grn.lines[0]!.pendingSerials).toEqual([extra]);
      // The same handset lands under P1 by an adjustment.
      await http()
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: wh, skuId: sku('P1'), binId: storageBin, quantityDelta: 1, reasonCode: 'stock-count', note: 'found', serials: [extra] })
        .expect(201);
      const refused = await decide(await overReceiptOf(grn.id), 'approve').expect(409);
      expect(refused.body.code).toBe('serial-in-stock');
      expect(refused.body.detail).toContain(`"${extra}" is already in stock under SKU "P1" at A-01`);
    });

    it('C19: a pending serial written off before approval books on approve, marked after_write_off, audited with the approver', async () => {
      const { poId, lineId } = await newPo(sku('S'), 1);
      const [a, c] = [sn(), sn()];
      const grn = await received({ poId, lines: [line(sku('S'), [a, c], { poLineId: lineId })] });
      const cId = (await serialId(sku('S'), c))!;
      await appendSerialEvent({ type: 'stock.adjusted', skuId: sku('S'), serialRef: cId, quantityDelta: 1000, fromBinId: null, toBinId: storageBin });
      await appendSerialEvent({ type: 'stock.adjusted', skuId: sku('S'), serialRef: cId, quantityDelta: -1000, fromBinId: storageBin, toBinId: null });
      const overReceiptId = await overReceiptOf(grn.id);
      const key = ulid();
      await decide(overReceiptId, 'approve', key).expect(200);
      expect((await rowsOf(grn.lines[0]!.id))[1]).toMatchObject({ state: 'applied', after_write_off: true });
      expect((await linesRead(grn.id))[0]).toMatchObject({ serials: [{ serial: a, state: 'applied' }, { serial: c, state: 'applied', afterWriteOff: true }] });
      await expectAuditRow({
        tenantId,
        key,
        action: 'goods_receipt.serial_re_received',
        targetType: 'goods_receipt',
        targetId: grn.id,
        actorUserId: ownerUserId,
        alongside: [{ action: 'over_receipt.approved', targetType: 'over_receipt', targetId: overReceiptId, actorUserId: ownerUserId }],
      });
    });

    it('C18/C24: a serial line naming an unknown PO line is rejected whole — its serials get no identity, and its format refusal is not serialsOnly', async () => {
      const { poId, lineId } = await newPo(sku('P1'), 5);
      const [fresh, ok] = [imei(), imei()];
      const grn = await received({
        poId,
        lines: [line(sku('P1'), ['490154203237517', fresh], { poLineId: uuidv7() }), line(sku('P1'), [ok], { poLineId: lineId })],
      });
      expect(grn.lines.map((entry) => entry.serials)).toEqual([[ok]]);
      const codes = (grn.rejectedLines ?? []).map((entry) => [entry.code, entry.serialsOnly ?? false]);
      expect(codes).toEqual(expect.arrayContaining([['serial-format-invalid', false], ['po-line-not-found', false]]));
      expect(await serialId(sku('P1'), fresh)).toBeUndefined();
    });

    it('C18: an ASN serial line books per unit and credits the ASN line', async () => {
      const asn = (
        await http()
          .post(`${API}/${tenantId}/inbound/asns`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ clientId: client('PLAIN'), warehouseId: wh, asnCode: `ASN-${ulid().slice(14)}`, lines: [{ skuId: sku('S'), announcedQty: 2 }] })
          .expect(201)
      ).body.asn as { id: string; lines: { id: string }[] };
      const [a, b] = [sn(), sn()];
      const grn = await received({ poId: null, asnId: asn.id, lines: [line(sku('S'), [a, b], { poLineId: null, asnLineId: asn.lines[0]!.id })] });
      expect(grn.lines[0]).toMatchObject({ appliedQty: 2, serials: [a, b] });
      expect(Number((await sql`select received_qty from asn_lines where id = ${asn.lines[0]!.id}`)[0]!.received_qty)).toBe(2000);
    });

    it('C17: review-row words — two serial codes, and a serial refusal beside a line refusal', async () => {
      const held = sn();
      await received(blind('PLAIN', [line(sku('S'), [held])]));
      const two = await received(blind('PLAIN', [line(sku('U'), [sn()]), line(sku('S'), [held, sn()])]));
      const row = await rejectedOp(two.reviewOpId!);
      expect(row.problem_code).toBe('serials-on-untracked');
      expect(row.problem_detail).toBe(
        `2 serial unit(s) of goods receipt "${two.code}" were not booked (1 serials on a SKU that is not serial-tracked; 1 already in stock). 1 line(s) were refused whole. Each entry names its serials — check the units, then discard this review.`,
      );
      const held2 = sn();
      await received(blind('PLAIN', [line(sku('S'), [held2])]));
      const mixed = await received(blind('PLAIN', [line(sku('BS'), [sn()], { batchCode: 'B-MIX' }), line(sku('S'), [held2, sn()])]));
      const mixedRow = await rejectedOp(mixed.reviewOpId!);
      expect(mixedRow.problem_code).toBe('sku-client-mismatch');
      expect(mixedRow.problem_detail).toMatch(/^1 line\(s\) of goods receipt ".+" were not booked — their SKUs belong to another client/);
      expect(mixedRow.problem_detail).toContain(` 1 serial unit(s) of goods receipt "${mixed.code}" were not booked (1 already in stock). The rest of each line booked.`);
    });
  });

  describe('serial format on the SKU', () => {
    it('C16: create with serialFormat imei stores it (response and snapshot); imei without serial tracking is a 400', async () => {
      const create = (body: Record<string, unknown>): request.Test =>
        http()
          .post(`${API}/${tenantId}/catalog/skus`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code: `IM-${ulid().slice(18)}`, name: 'Phone', uom: 'each', gstRate: 1800, batchTracked: false, catchWeightTracked: false, clientId: client('PLAIN'), ...body });
      const made = await create({ serialTracked: true, serialFormat: 'imei' }).expect(201);
      expect(made.body.sku).toMatchObject({ serialTracked: true, serialFormat: 'imei' });
      const plain = await create({ serialTracked: true }).expect(201);
      expect(plain.body.sku.serialFormat).toBe('free');
      const refused = await create({ serialTracked: false, serialFormat: 'imei' }).expect(400);
      expect(refused.body.detail).toContain('not serial-tracked');
      const snapshot = await http()
        .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${wh}`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);
      expect((snapshot.body.skus as { id: string; serialFormat: string }[]).find((entry) => entry.id === made.body.sku.id)!.serialFormat).toBe('imei');
    });

    it('imei without serial tracking is a 400; ending serial tracking resets imei to free (A15)', async () => {
      const refused = await patchSku(sku('U'), { serialFormat: 'imei' }).expect(400);
      expect(refused.body.detail).toContain('not serial-tracked');
      await importSkus('PLAIN', [['FLIP', false, true]]);
      await patchSku(sku('FLIP'), { serialFormat: 'imei' }).expect(200);
      const ended = await patchSku(sku('FLIP'), { serialTracked: false }).expect(200);
      expect(ended.body).toMatchObject({ serialTracked: false, serialFormat: 'free' });
      const back = await patchSku(sku('FLIP'), { serialTracked: true }).expect(200);
      expect(back.body.serialFormat).toBe('free');
      await patchSku(sku('FLIP'), { serialFormat: 'IMEI' }).expect(400);
    });
  });
});
