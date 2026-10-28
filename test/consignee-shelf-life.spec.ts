import type { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import request from 'supertest';
import { ulid } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { addIsoDays, istDateOf, istMidnightOf } from '../src/shared/primitives/time';
import {
  CONSIGNEE_MIN_SHELF_LIFE_DAYS_MAX,
  CONSIGNEE_MIN_SHELF_LIFE_DAYS_MIN,
  CONSIGNEE_MIN_SHELF_LIFE_PERCENT_MAX,
  CONSIGNEE_MIN_SHELF_LIFE_PERCENT_MIN,
  SHORTFALL_CAUSES,
} from '../src/shared/primitives/batch-allocation';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { batchExpiryClock } from '../src/shared/primitives/batch-expiry';
import { WAVE_CLOCK, type WaveClock } from '../src/modules/outbound/wave.clock';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import type { Database } from '../src/shared/db/db';
import { consigneeRuleKey, consigneeShelfLifeRulesInTx, normalizeOrderGstin } from '../src/modules/partners/partners.facade';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow, noOpIdempotencyKey } from './support/audit-guard';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';

/**
 * Story 4-3b — customer shelf life: a consignee's own minimum remaining shelf
 * life (days and/or percent of the SKU's total shelf life) on its client
 * link, resolved from the order's consignee GSTIN, applied per order line by
 * the wave plan, the short-pick re-plan and the pick draw, and explained by
 * the order read. Every matrix row (frozen and amended) is driven through
 * HTTP here; the pure conversion and predicate are unit-tested in
 * `test/consignee-shelf-life-primitives.spec.ts`.
 */

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;

jest.setTimeout(120_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

/** GSTINs (state 27, a PAN-shaped body) — one partner each. */
const GSTIN = {
  DMART: '27AAACD1111A1Z5',
  PCT: '27AAACP2222B1Z5',
  BOTH: '27AAACB3333C1Z5',
  INACT: '27AAACI4444D1Z5',
  ROLE: '27AAACR5555E1Z5',
  NORULE: '27AAACN6666F1Z5',
  NOLINK: '27AAACL7777G1Z5',
  UNKNOWN: '27AAACU8888H1Z5',
  EDIT: '27AAACE9999J1Z5',
  MIXED: '27AAACM1212K1Z5',
} as const;

interface Line {
  id: string;
  picklistId: string;
  orderId: string;
  orderLineId: string;
  skuId: string;
  binId: string | null;
  binCode: string | null;
  batchId: string | null;
  batchCode?: string | null;
  qty: number;
  shortfallQty: number;
  status: string;
  allocationRule?: string | null;
  minOutboundShelfLifeDays?: number | null;
  consigneeName?: string | null;
  consigneeMinShelfLifeDays?: number | null;
  consigneeMinShelfLifePercent?: number | null;
  consigneeShelfLifeBaseDays?: number | null;
  shortfallCause?: string | null;
}
interface WaveBody {
  id: string;
  picklists: { id: string; orderId: string | null; lines: Line[] }[];
}
interface PartnerBody {
  id: string;
  code: string;
  links: { id: string; clientId: string; role: string; active: boolean; minShelfLifeDays?: number | null; minShelfLifePercent?: number | null }[];
}

describe('story 4-3b: customer shelf life (e2e)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let suiteDb: SuiteDatabase;
  let inventory: InventoryFacade;
  let tenantId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let opsToken: string;
  let webOperatorToken: string;
  let operatorToken: string;
  let wh: string;
  let zoneId: string;
  const bins = new Map<string, string>();
  const clientIds = new Map<string, string>();
  const skuIds = new Map<string, string>();
  const partners = new Map<string, PartnerBody>();
  let today: string;

  const http = () => request(app.getHttpServer());
  const bin = (code: string) => bins.get(code)!;
  const client = (code: string) => {
    const id = clientIds.get(code);
    if (id === undefined) throw new Error(`unknown client ${code}`);
    return id;
  };
  const sku = (code: string) => {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown SKU ${code}`);
    return id;
  };
  const partner = (code: string) => {
    const p = partners.get(code);
    if (p === undefined) throw new Error(`unknown partner ${code}`);
    return p;
  };
  const linkOf = (partnerCode: string, clientCode: string) =>
    partner(partnerCode).links.find((l) => l.clientId === client(clientCode) && l.role === 'consignee')!;
  const expiresIn = (days: number) => istMidnightOf(addIsoDays(today, days));
  /** 10:00 IST on today + n days. */
  const istTen = (days: number) => new Date(Date.parse(`${addIsoDays(today, days)}T04:30:00.000Z`));

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('consignee_shelf_life');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });
    inventory = app.get(InventoryFacade);
    today = istDateOf(new Date().toISOString());

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Consignee Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    const signedIn = await mintSignIn(app, { email, password: 'correct-horse-battery' });
    ownerToken = signedIn.body.accessToken as string;
    ownerUserId = signedIn.body.user.id as string;
    opsToken = await inviteAndSignIn('ops_manager', 'ops-password-123');
    webOperatorToken = await inviteAndSignIn('operator', 'operator-password-123');

    wh = (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `CS-${ulid().slice(20)}`, name: 'Consignee warehouse' })
        .expect(201)
    ).body.id as string;
    zoneId = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${wh}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
    for (const code of ['C-01', 'B-01', 'A-01']) {
      bins.set(
        code,
        (
          await http()
            .post(`${API}/${tenantId}/warehouses/${wh}/zones/${zoneId}/bins`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .set(KEY_HEADER, ulid())
            .send({ code, capacity: 1_000_000, type: 'shelf' })
            .expect(201)
        ).body.id as string,
      );
    }
    for (const code of ['BRAND', 'CMIN', 'TIE', 'OTHER']) {
      clientIds.set(
        code,
        (
          await http()
            .post(`${API}/${tenantId}/clients`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .set(KEY_HEADER, ulid())
            .send({ code, name: `${code} Brand` })
            .expect(201)
        ).body.client.id as string,
      );
    }
    await importSkus('BRAND', [
      ['D-DAYS', 'pcs', true],
      ['D-PCT', 'pcs', true],
      ['D-BOTH', 'pcs', true],
      ['D-NONE', 'pcs', true],
      ['D-PART', 'pcs', true],
      ['D-UJ', 'pcs', true],
      ['D-UND', 'pcs', true],
      ['D-LESS', 'pcs', true],
      ['D-UNTRK', 'pcs', false],
      ['D-INACT', 'pcs', true],
      ['D-ROLE', 'pcs', true],
      ['D-LOWER', 'pcs', true],
      ['D-TWO', 'pcs', true],
      ['D-KG', 'kg', true],
      ['D-DERIV', 'pcs', true],
      ['D-NOSTOCK', 'pcs', true],
      ['K-KIT', 'pcs', false],
      ['K-COMP', 'pcs', true],
      ['E-EDIT', 'pcs', true],
      ['P-IN', 'pcs', true],
      ['P-ONLY', 'pcs', true],
      ['P-UJ', 'pcs', true],
      ['R-RP', 'pcs', true],
      ['R-UJ', 'pcs', true],
      ['O-A', 'pcs', true],
      ['O-B', 'pcs', false],
      ['O-CL', 'pcs', true],
      ['W-SNAP', 'pcs', true],
      ['G-GRACE', 'pcs', true],
      ['G-CAP', 'pcs', true],
      ['P-LESS', 'pcs', true],
      ['A-CLAIM', 'pcs', true],
      ['A-A11', 'pcs', true],
    ]);
    await importSkus('CMIN', [['C-STRICT', 'pcs', true], ['C-PICK', 'pcs', true], ['C-UND', 'pcs', true], ['C-READ', 'pcs', true]]);
    await importSkus('TIE', [['T-TIE', 'pcs', true]]);
    await importSkus('OTHER', [['X-OTHER', 'pcs', true]]);
    await sql`update skus set shelf_life_days = 180 where tenant_id = ${tenantId} and code in ('D-PCT', 'D-BOTH', 'D-TWO')`;

    await http()
      .put(`${API}/${tenantId}/clients/${client('CMIN')}/allocation-policy`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ allocationRule: 'fefo', minOutboundShelfLifeDays: 150 })
      .expect(200);
    await http()
      .put(`${API}/${tenantId}/clients/${client('TIE')}/allocation-policy`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ allocationRule: 'fefo', minOutboundShelfLifeDays: 120 })
      .expect(200);

    // The consignees and their links.
    await createConsignee('DMART', 'DMart Avenue', GSTIN.DMART, ['BRAND', 'CMIN', 'TIE']);
    await createConsignee('PCT', 'Percent Mart', GSTIN.PCT, ['BRAND']);
    await createConsignee('BOTH', 'Both Mart', GSTIN.BOTH, ['BRAND']);
    await createConsignee('INACT', 'Inactive Mart', GSTIN.INACT, ['BRAND']);
    await createConsignee('ROLE', 'Role Mart', GSTIN.ROLE, ['BRAND'], ['consignee', 'vendor']);
    await createConsignee('NORULE', 'No Rule Mart', GSTIN.NORULE, ['BRAND']);
    await createConsignee('NOLINK', 'No Link Mart', GSTIN.NOLINK, []);
    await createConsignee('EDIT', 'Edit Mart', GSTIN.EDIT, ['BRAND']);
    await createConsignee('MIXED', 'Mixed Mart', GSTIN.MIXED, ['BRAND'], ['vendor', 'consignee']);
    for (const [code, clientCode] of [['DMART', 'BRAND'], ['DMART', 'CMIN'], ['DMART', 'TIE'], ['INACT', 'BRAND'], ['ROLE', 'BRAND'], ['EDIT', 'BRAND']] as const) {
      await putShelfLife(code, clientCode, { minShelfLifeDays: 120, minShelfLifePercent: null }).expect(200);
    }
    await putShelfLife('PCT', 'BRAND', { minShelfLifeDays: null, minShelfLifePercent: 70 }).expect(200);
    await putShelfLife('BOTH', 'BRAND', { minShelfLifeDays: 100, minShelfLifePercent: 70 }).expect(200);

    // The handheld: one enrolled device and its badge-in operator.
    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Consignee scanner', pin: '1357' })
      .expect(201);
    const operatorEmail = `floor-${ulid().toLowerCase()}@example.com`;
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
      .send({ operatorEmail, pin: '1357' })
      .expect(200);
    operatorToken = badged.body.accessToken as string;
    await inventory.rebuildReservationCounters(tenantId, wh);
  });

  afterEach(() => {
    batchExpiryClock.now = () => Date.now();
  });

  afterAll(async () => {
    batchExpiryClock.now = () => Date.now();
    const rawDb = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await rawDb.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await sql.end();
    await app.close();
    await suiteDb.drop();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function inviteAndSignIn(role: string, password: string, clientId?: string): Promise<string> {
    const address = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email: address, role, ...(clientId === undefined ? {} : { clientId }) })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password })
      .expect(200);
    return (await mintSignIn(app, { email: address, password })).body.accessToken as string;
  }

  async function importSkus(clientCode: string, rows: readonly (readonly [string, string, boolean])[]): Promise<void> {
    const csv = [
      'sku_code,name,uom,gst_rate,barcode,batch_tracked,serial_tracked',
      ...rows.map(([code, uom, batch]) => `${code},${code} name,${uom},1800,${clientCode}-${code}-BC,${batch},false`),
    ].join('\n');
    await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', client(clientCode))
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const stored = (await sql`select id, code from skus where tenant_id = ${tenantId} and client_id = ${client(clientCode)}`) as unknown as {
      id: string;
      code: string;
    }[];
    for (const row of stored) skuIds.set(row.code, row.id);
  }

  async function createConsignee(code: string, name: string, gstin: string, clientCodes: readonly string[], roles: readonly string[] = ['consignee']): Promise<void> {
    let body = (
      await http()
        .post(`${API}/${tenantId}/partners`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code, name, roles, gstin })
        .expect(201)
    ).body.partner as PartnerBody;
    for (const clientCode of clientCodes) {
      body = (
        await http()
          .post(`${API}/${tenantId}/partners/${body.id}/links`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ clientId: client(clientCode), role: 'consignee' })
          .expect(201)
      ).body.partner as PartnerBody;
    }
    partners.set(code, body);
  }

  function putShelfLifeRaw(partnerId: string, linkId: string, body: Record<string, unknown>, key = ulid(), token = ownerToken) {
    return http()
      .put(`${API}/${tenantId}/partners/${partnerId}/links/${linkId}/shelf-life`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function putShelfLife(partnerCode: string, clientCode: string, body: Record<string, unknown>, key = ulid(), token = ownerToken) {
    return putShelfLifeRaw(partner(partnerCode).id, linkOf(partnerCode, clientCode).id, body, key, token);
  }

  async function seed(skuCode: string, binCode: string, quantity: number, batch?: { code: string; expiryDate?: string | null }): Promise<void> {
    await http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId: wh,
        skuId: sku(skuCode),
        binId: bin(binCode),
        quantityDelta: quantity,
        reasonCode: 'stock-count',
        note: 'consignee seed',
        ...(batch === undefined
          ? {}
          : { batch: { code: batch.code, ...(batch.expiryDate == null ? {} : { expiryDate: batch.expiryDate }) } }),
      })
      .expect(201);
  }

  async function order(lines: { skuCode: string; quantity: number }[], gstin?: string): Promise<string> {
    const res = await http()
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId: wh,
        lines: lines.map((l) => ({ skuId: sku(l.skuCode), quantity: l.quantity })),
        destination: testAddress(),
        ...(gstin === undefined ? {} : { consigneeGstin: gstin }),
      })
      .expect(201);
    return res.body.order.id as string;
  }

  async function wavePolicy(): Promise<string> {
    const res = await http()
      .post(`${API}/${tenantId}/outbound/wave-policies`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, name: `cs-${ulid().slice(10, 20)}`, grouping: 'single' })
      .expect(201);
    return res.body.policy.id as string;
  }

  function generate(orderIds: string[], policyId: string, key = ulid()) {
    return http()
      .post(`${API}/${tenantId}/outbound/waves`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId: wh, policyId, orderIds });
  }

  async function wave(orderIds: string[], opts: { release?: boolean; at?: Date } = {}): Promise<WaveBody> {
    const policyId = await wavePolicy();
    if (opts.at !== undefined) jest.spyOn(app.get<WaveClock>(WAVE_CLOCK), 'now').mockReturnValue(opts.at);
    const res = await generate(orderIds, policyId).expect(201);
    const waveId = res.body.wave.id as string;
    if (opts.release !== false) {
      await http()
        .post(`${API}/${tenantId}/outbound/waves/${waveId}/release`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({})
        .expect(200);
    }
    return (await http().get(`${API}/${tenantId}/outbound/waves/${waveId}`).set('Authorization', `Bearer ${opsToken}`).expect(200)).body
      .wave as WaveBody;
  }

  const linesOf = (w: WaveBody, orderId?: string) =>
    w.picklists.flatMap((p) => p.lines).filter((l) => orderId === undefined || l.orderId === orderId);
  const sliceText = (lines: Line[]) =>
    lines.map((l) => (l.status === 'unfulfillable' ? `short:${l.shortfallQty}:${l.shortfallCause ?? 'null'}` : `${l.batchCode ?? 'none'}:${l.qty}`));

  function pick(line: Line, overrides: Record<string, unknown> = {}, key = ulid()) {
    return http()
      .post(`${API}/${tenantId}/outbound/picks`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, key)
      .send({
        warehouseId: wh,
        picklistId: line.picklistId,
        picklistLineId: line.id,
        skuId: line.skuId,
        binId: line.binId,
        qty: line.qty,
        occurredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        ...overrides,
      });
  }

  async function drawnBatchCodes(lineId: string): Promise<{ code: string; qty: number }[]> {
    const rows = (await sql`
      select b.code, e.quantity_delta
      from ledger_events e join batches b on b.id::text = e.batch_ref
      where e.tenant_id = ${tenantId} and e.reference_doc ->> 'picklistLineId' = ${lineId}
      order by e.seq
    `) as unknown as { code: string; quantity_delta: string }[];
    return rows.map((row) => ({ code: row.code, qty: -Number(row.quantity_delta) / 1000 }));
  }

  async function blockBatch(code: string): Promise<void> {
    const id = ((await sql`select id from batches where tenant_id = ${tenantId} and code = ${code}`) as unknown as { id: string }[])[0]!.id;
    await http()
      .post(`${API}/${tenantId}/inventory/batches/${id}/block`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ reason: 'recall' })
      .expect(201);
  }

  async function stored(lineId: string) {
    return ((await sql`select consignee_partner_id, consignee_min_shelf_life_days, consignee_min_shelf_life_percent, shortfall_cause,
        consignee_shelf_life_base_days, allocation_rule, min_outbound_shelf_life_days from picklist_lines where id = ${lineId}`) as unknown as Record<string, unknown>[])[0]!;
  }

  function shelfLifeOf(orderId: string, token = opsToken) {
    return http().get(`${API}/${tenantId}/outbound/orders/${orderId}/shelf-life`).set('Authorization', `Bearer ${token}`);
  }

  // ── the vocabulary and the migration ──────────────────────────────────────

  describe('the schema', () => {
    it('the bounds and SHORTFALL_CAUSES are pinned against the 0111 CHECKs (NOT VALID tolerated); the link CHECKs are VALID, the line CHECKs NOT VALID', async () => {
      const rows = (await sql`
        select conname, pg_get_constraintdef(oid) as def, convalidated
        from pg_constraint
        where conname in ('partner_client_links_min_shelf_life_days_range', 'partner_client_links_min_shelf_life_percent_range',
                          'partner_client_links_shelf_life_consignee_only',
                          'picklist_lines_consignee_min_shelf_life_days_range', 'picklist_lines_consignee_min_shelf_life_percent_range',
                          'picklist_lines_consignee_shelf_life_base_days_range', 'picklist_lines_consignee_base_needs_percent',
                          'picklist_lines_consignee_pairing', 'picklist_lines_consignee_needs_rule', 'picklist_lines_shortfall_cause_check')
      `) as unknown as { conname: string; def: string; convalidated: boolean }[];
      const def = new Map(rows.map((row) => [row.conname, row.def.replace(/ NOT VALID$/, '')]));
      for (const name of [
        'partner_client_links_min_shelf_life_days_range',
        'picklist_lines_consignee_min_shelf_life_days_range',
        'picklist_lines_consignee_shelf_life_base_days_range',
      ]) {
        expect(def.get(name)).toContain(`>= ${CONSIGNEE_MIN_SHELF_LIFE_DAYS_MIN}`);
        expect(def.get(name)).toContain(`<= ${CONSIGNEE_MIN_SHELF_LIFE_DAYS_MAX}`);
      }
      for (const name of ['partner_client_links_min_shelf_life_percent_range', 'picklist_lines_consignee_min_shelf_life_percent_range']) {
        expect(def.get(name)).toContain(`>= ${CONSIGNEE_MIN_SHELF_LIFE_PERCENT_MIN}`);
        expect(def.get(name)).toContain(`<= ${CONSIGNEE_MIN_SHELF_LIFE_PERCENT_MAX}`);
      }
      expect([...def.get('picklist_lines_shortfall_cause_check')!.matchAll(/'([a-z-]+)'::text/g)].map((m) => m[1])).toEqual([...SHORTFALL_CAUSES]);
      expect(def.get('partner_client_links_shelf_life_consignee_only')).toContain("'consignee'");
      expect(Object.fromEntries(rows.map((row) => [row.conname, row.convalidated]))).toEqual({
        partner_client_links_min_shelf_life_days_range: true,
        partner_client_links_min_shelf_life_percent_range: true,
        partner_client_links_shelf_life_consignee_only: true,
        picklist_lines_consignee_min_shelf_life_days_range: false,
        picklist_lines_consignee_min_shelf_life_percent_range: false,
        picklist_lines_consignee_shelf_life_base_days_range: false,
        picklist_lines_consignee_base_needs_percent: false,
        picklist_lines_consignee_pairing: false,
        picklist_lines_consignee_needs_rule: false,
        picklist_lines_shortfall_cause_check: false,
      });
    });
  });

  // ── the rule on the link ──────────────────────────────────────────────────

  describe('the shelf-life PUT', () => {
    it('an owner sets a consignee link\'s rule: 200 {partner} carrying it; audited with before/after; a replay re-serves; another body under the key is 422', async () => {
      const key = ulid();
      const link = linkOf('NORULE', 'BRAND');
      const res = await putShelfLife('NORULE', 'BRAND', { minShelfLifeDays: 120, minShelfLifePercent: null }, key).expect(200);
      expect((res.body.partner as PartnerBody).links.find((l) => l.id === link.id)).toMatchObject({ minShelfLifeDays: 120, minShelfLifePercent: null });
      await expectAuditRow({ tenantId, key, action: 'partner.link_shelf_life_updated', targetType: 'partner_link', targetId: link.id, actorUserId: ownerUserId });
      const audit = (await sql`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key}`) as unknown as { changes: unknown }[];
      expect(audit[0]!.changes).toEqual({
        clientId: client('BRAND'),
        partnerId: partner('NORULE').id,
        minShelfLifeDays: { before: null, after: 120 },
        minShelfLifePercent: { before: null, after: null },
      });
      const replay = await putShelfLife('NORULE', 'BRAND', { minShelfLifeDays: 120, minShelfLifePercent: null }, key).expect(200);
      expect(replay.body).toEqual(res.body);
      await expectAuditRow({ tenantId, key, action: 'partner.link_shelf_life_updated', targetType: 'partner_link', targetId: link.id, actorUserId: ownerUserId });
      const reuse = await putShelfLife('NORULE', 'BRAND', { minShelfLifeDays: 121, minShelfLifePercent: null }, key).expect(422);
      expect(reuse.body.code).toBe('idempotency-key-reuse');
      // The hash golden (A9): the raw body values, in this key order.
      const golden = createHash('sha256')
        .update(
          `{"arm":"link-shelf-life","tenantId":"${tenantId}","partnerId":"${partner('NORULE').id}","linkId":"${link.id}","minShelfLifeDays":120,"minShelfLifePercent":null}`,
          'utf8',
        )
        .digest('hex');
      const keyRow = (await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as { payload_hash: string }[];
      expect(keyRow[0]!.payload_hash).toBe(golden);
      // Back to "no rule" for the resolution row below.
      await putShelfLife('NORULE', 'BRAND', { minShelfLifeDays: null, minShelfLifePercent: null }).expect(200);
    });

    it('the same values again are a no-op that stores the key (no audit row)', async () => {
      const key = ulid();
      noOpIdempotencyKey(tenantId, key, 'partners.linkShelfLife:unchanged');
      const res = await putShelfLife('DMART', 'BRAND', { minShelfLifeDays: 120, minShelfLifePercent: null }, key).expect(200);
      expect(res.body.partner.links.find((l: { id: string }) => l.id === linkOf('DMART', 'BRAND').id)).toMatchObject({ minShelfLifeDays: 120 });
      expect(await sql`select 1 from audit_events where tenant_id = ${tenantId} and reference = ${key}`).toHaveLength(0);
      expect(await sql`select 1 from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`).toHaveLength(1);
    });

    it('bad bodies: a vendor link 400 link-role-invalid; 0, 3651, 101, 1.5 and a missing key 400 validation-failed naming the field', async () => {
      const vendorLink = (
        await http()
          .post(`${API}/${tenantId}/partners/${partner('MIXED').id}/links`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ clientId: client('BRAND'), role: 'vendor' })
          .expect(201)
      ).body.partner.links.find((l: { role: string }) => l.role === 'vendor') as { id: string };
      const vendor = await putShelfLifeRaw(partner('MIXED').id, vendorLink.id, { minShelfLifeDays: 30, minShelfLifePercent: null }).expect(400);
      expect(vendor.body.code).toBe('link-role-invalid');
      const cases: [Record<string, unknown>, string][] = [
        [{ minShelfLifeDays: 0, minShelfLifePercent: null }, 'minShelfLifeDays'],
        [{ minShelfLifeDays: 3651, minShelfLifePercent: null }, 'minShelfLifeDays'],
        [{ minShelfLifeDays: null, minShelfLifePercent: 101 }, 'minShelfLifePercent'],
        [{ minShelfLifeDays: 1.5, minShelfLifePercent: null }, 'minShelfLifeDays'],
        [{ minShelfLifeDays: 120 }, 'minShelfLifePercent'],
        [{ minShelfLifePercent: 50 }, 'minShelfLifeDays'],
      ];
      for (const [body, field] of cases) {
        const refused = await putShelfLife('MIXED', 'BRAND', body).expect(400);
        expect(refused.body.code).toBe('validation-failed');
        expect(JSON.stringify(refused.body)).toContain(field);
      }
    });

    it('authority and scope: a web operator 403; an unknown link 404; ANOTHER partner\'s link 404', async () => {
      const denied = await putShelfLife('DMART', 'BRAND', { minShelfLifeDays: 90, minShelfLifePercent: null }, ulid(), webOperatorToken).expect(403);
      expect(denied.body.code).toBe('role-denied');
      await putShelfLifeRaw(partner('DMART').id, '01900000-0000-7000-8000-0000000000aa', { minShelfLifeDays: 90, minShelfLifePercent: null }).expect(404);
      const foreign = await putShelfLifeRaw(partner('PCT').id, linkOf('DMART', 'BRAND').id, { minShelfLifeDays: 90, minShelfLifePercent: null }).expect(404);
      expect(foreign.body.code).toBe('not-found');
    });

    it('a same-key race parked on the partner lock answers both requests with the winner\'s snapshot, one audit row, one key', async () => {
      const key = ulid();
      const body = { minShelfLifeDays: 45, minShelfLifePercent: 10 };
      const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
      let first: Promise<request.Response> | undefined;
      let second: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const locked = (await tx`select pg_backend_pid() as pid from business_partners where tenant_id = ${tenantId} and id = ${partner('MIXED').id} for update`) as unknown as {
            pid: number;
          }[];
          first = (async () => putShelfLife('MIXED', 'BRAND', body, key))();
          second = (async () => putShelfLife('MIXED', 'BRAND', body, key))();
          await waitParked(locked[0]!.pid, 2);
        });
        const [a, b] = await Promise.all([first!, second!]);
        expect([a.status, b.status]).toEqual([200, 200]);
        expect(b.body).toEqual(a.body);
        expect(await sql`select 1 from audit_events where tenant_id = ${tenantId} and reference = ${key}`).toHaveLength(1);
        expect(await sql`select 1 from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`).toHaveLength(1);
      } finally {
        await Promise.allSettled([first, second]);
        await holder.end();
      }
    });

    it('allowed on a switched-off link (a policy, not work); a PartnerMutationSnapshot stored before 4-3b replays unchanged — its links without the two fields', async () => {
      const key = ulid();
      const link = linkOf('INACT', 'BRAND');
      const off = await http()
        .patch(`${API}/${tenantId}/partners/${partner('INACT').id}/links/${link.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, key)
        .send({ active: false })
        .expect(200);
      expect(off.body.partner.links[0]).toMatchObject({ active: false, minShelfLifeDays: 120 });
      // Make the stored answer what a pre-4-3b build stored.
      await sql`update idempotency_keys set response_snapshot = jsonb_set(response_snapshot, '{partner,links,0}',
          (response_snapshot #> '{partner,links,0}') - 'minShelfLifeDays' - 'minShelfLifePercent')
        where tenant_id = ${tenantId} and key = ${key}`;
      const replay = await http()
        .patch(`${API}/${tenantId}/partners/${partner('INACT').id}/links/${link.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, key)
        .send({ active: false })
        .expect(200);
      expect(replay.body.partner.links[0]).not.toHaveProperty('minShelfLifeDays');
      expect(replay.body.partner.links[0]).not.toHaveProperty('minShelfLifePercent');
      // The PUT itself is allowed on the switched-off link (same value → its no-op arm).
      const noop = ulid();
      noOpIdempotencyKey(tenantId, noop, 'partners.linkShelfLife:unchanged');
      await putShelfLife('INACT', 'BRAND', { minShelfLifeDays: 120, minShelfLifePercent: null }, noop).expect(200);
    });

    it('allowed on a departed client\'s consignee link (a policy, not work)', async () => {
      const goneId = (
        await http().post(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code: 'GONE', name: 'Gone Brand' }).expect(201)
      ).body.client.id as string;
      clientIds.set('GONE', goneId);
      const linked = (
        await http()
          .post(`${API}/${tenantId}/partners/${partner('NOLINK').id}/links`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ clientId: goneId, role: 'consignee' })
          .expect(201)
      ).body.partner as PartnerBody;
      await http().patch(`${API}/${tenantId}/clients/${goneId}/status`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ status: 'departed' }).expect(200);
      const link = linked.links.find((l) => l.clientId === goneId)!;
      const res = await putShelfLifeRaw(partner('NOLINK').id, link.id, { minShelfLifeDays: 30, minShelfLifePercent: null }).expect(200);
      expect((res.body.partner as PartnerBody).links.find((l) => l.id === link.id)).toMatchObject({ minShelfLifeDays: 30 });
    });

    it('the PUT and the order read are in the OpenAPI document with their documented arms', async () => {
      const doc = await http().get('/api/v1/openapi.json').expect(200);
      const paths = doc.body.paths as Record<string, Record<string, { responses: Record<string, unknown> }>>;
      expect(Object.keys(paths['/tenants/{tenantId}/partners/{partnerId}/links/{linkId}/shelf-life']!.put!.responses).sort()).toEqual([
        '200', '400', '401', '403', '404', '409', '422',
      ]);
      expect(Object.keys(paths['/tenants/{tenantId}/outbound/orders/{orderId}/shelf-life']!.get!.responses).sort()).toEqual([
        '200', '400', '401', '403', '404',
      ]);
    });
  });

  // ── the wave plan ─────────────────────────────────────────────────────────

  describe('the wave plan', () => {
    it('days rule + B2C in the same wave + contention: the B2C line (first) takes the short-life lot, the DMart line skips it and takes the 200-day lot, stamped DMart / 120', async () => {
      await seed('D-DAYS', 'A-01', 10, { code: 'DD-L1', expiryDate: expiresIn(60) });
      await seed('D-DAYS', 'B-01', 10, { code: 'DD-L2', expiryDate: expiresIn(200) });
      const b2c = await order([{ skuCode: 'D-DAYS', quantity: 5 }]);
      const dmart = await order([{ skuCode: 'D-DAYS', quantity: 5 }], GSTIN.DMART);
      const w = await wave([b2c, dmart]);
      expect(sliceText(linesOf(w, b2c))).toEqual(['DD-L1:5']);
      expect(sliceText(linesOf(w, dmart))).toEqual(['DD-L2:5']);
      expect(linesOf(w, b2c)[0]).toMatchObject({ consigneeName: null, consigneeMinShelfLifeDays: null, shortfallCause: null });
      expect(linesOf(w, dmart)[0]).toMatchObject({ consigneeName: 'DMart Avenue', consigneeMinShelfLifeDays: 120, consigneeMinShelfLifePercent: null });
      expect(await stored(linesOf(w, dmart)[0]!.id)).toMatchObject({
        consignee_partner_id: partner('DMART').id,
        consignee_min_shelf_life_days: 120,
        consignee_shelf_life_base_days: null,
      });
      // The handheld task carries the consignee hint's facts.
      const snap = await http().get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${wh}`).set('Authorization', `Bearer ${operatorToken}`).expect(200);
      const tasks = snap.body.pickTasks as Record<string, unknown>[];
      expect(tasks.find((t) => t.picklistLineId === linesOf(w, dmart)[0]!.id)).toMatchObject({ consigneeName: 'DMart Avenue', consigneeMinShelfLifeDays: 120 });
      expect(tasks.find((t) => t.picklistLineId === linesOf(w, b2c)[0]!.id)).toMatchObject({ consigneeName: null, consigneeMinShelfLifeDays: null });
    });

    it('percent rule: 70 % of a 180-day SKU is 126 days — the 100-day lot is skipped; the line is stamped 126 / 70 and shows the 180-day base', async () => {
      await seed('D-PCT', 'A-01', 10, { code: 'DP-L1', expiryDate: expiresIn(100) });
      await seed('D-PCT', 'B-01', 10, { code: 'DP-L2', expiryDate: expiresIn(150) });
      const id = await order([{ skuCode: 'D-PCT', quantity: 4 }], GSTIN.PCT);
      const [line] = linesOf(await wave([id]));
      expect(sliceText([line!])).toEqual(['DP-L2:4']);
      expect(line).toMatchObject({ consigneeName: 'Percent Mart', consigneeMinShelfLifeDays: 126, consigneeMinShelfLifePercent: 70, consigneeShelfLifeBaseDays: 180 });
      // A2 — the base is FROZEN: a later SKU edit does not rewrite the row.
      expect(await stored(line!.id)).toMatchObject({ consignee_shelf_life_base_days: 180 });
      await sql`update skus set shelf_life_days = 365 where tenant_id = ${tenantId} and code = 'D-PCT'`;
      try {
        const reread = (await http().get(`${API}/${tenantId}/outbound/waves/${(await sql`select wave_id from picklist_lines where id = ${line!.id}`)[0]!.wave_id as string}`).set('Authorization', `Bearer ${opsToken}`).expect(200)).body.wave as WaveBody;
        expect(linesOf(reread)[0]).toMatchObject({ consigneeMinShelfLifeDays: 126, consigneeShelfLifeBaseDays: 180 });
      } finally {
        await sql`update skus set shelf_life_days = 180 where tenant_id = ${tenantId} and code = 'D-PCT'`;
      }
    });

    it('both set: 100 days and 70 % of 180 → effective 126', async () => {
      await seed('D-BOTH', 'A-01', 10, { code: 'DB-L1', expiryDate: expiresIn(125) });
      await seed('D-BOTH', 'B-01', 10, { code: 'DB-L2', expiryDate: expiresIn(126) });
      const id = await order([{ skuCode: 'D-BOTH', quantity: 3 }], GSTIN.BOTH);
      const [line] = linesOf(await wave([id]));
      expect(sliceText([line!])).toEqual(['DB-L2:3']);
      expect(line).toMatchObject({ consigneeMinShelfLifeDays: 126, consigneeMinShelfLifePercent: 70 });
    });

    it('client stricter: client minimum 150, consignee 120 — judged at 150; the line stamps the client 150 and the consignee 120', async () => {
      await seed('C-STRICT', 'A-01', 10, { code: 'CS-L1', expiryDate: expiresIn(140) });
      await seed('C-STRICT', 'B-01', 10, { code: 'CS-L2', expiryDate: expiresIn(160) });
      const id = await order([{ skuCode: 'C-STRICT', quantity: 2 }], GSTIN.DMART);
      const [line] = linesOf(await wave([id]));
      expect(sliceText([line!])).toEqual(['CS-L2:2']);
      expect(line).toMatchObject({ minOutboundShelfLifeDays: 150, consigneeMinShelfLifeDays: 120 });
    });

    it('no qualifying stock: the whole reserved quantity plans unfulfillable, cause consignee-shelf-life; partial: 10 planned + 5 unfulfillable', async () => {
      await seed('D-NONE', 'A-01', 10, { code: 'DN-L1', expiryDate: expiresIn(60) });
      const none = await order([{ skuCode: 'D-NONE', quantity: 4 }], GSTIN.DMART);
      expect(sliceText(linesOf(await wave([none])))).toEqual(['short:4:consignee-shelf-life']);

      await seed('D-PART', 'A-01', 10, { code: 'PT-L1', expiryDate: expiresIn(60) });
      await seed('D-PART', 'B-01', 10, { code: 'PT-L2', expiryDate: expiresIn(200) });
      const part = await order([{ skuCode: 'D-PART', quantity: 15 }], GSTIN.DMART);
      expect(sliceText(linesOf(await wave([part])))).toEqual(['PT-L2:10', 'short:5:consignee-shelf-life']);
    });

    it('no stock at all: unfulfillable with cause null (the pre-4-3b meaning)', async () => {
      // An order backorders what it cannot reserve; plant a reservation-less stock-less line by draining after the order.
      await seed('D-NOSTOCK', 'A-01', 3, { code: 'NS-L1', expiryDate: expiresIn(200) });
      const id = await order([{ skuCode: 'D-NOSTOCK', quantity: 3 }], GSTIN.DMART);
      await sql`update batch_on_hand set quantity = 0 where tenant_id = ${tenantId} and sku_id = ${sku('D-NOSTOCK')}`;
      await sql`update stock_on_hand set quantity = 0 where tenant_id = ${tenantId} and sku_id = ${sku('D-NOSTOCK')}`;
      expect(sliceText(linesOf(await wave([id])))).toEqual(['short:3:null']);
    });

    it('unjudgeable: a percent rule on a SKU with no total shelf life — unfulfillable, cause consignee-unjudgeable; stamped percent 70, days null; the order read says judgeable:false', async () => {
      await seed('D-UJ', 'A-01', 10, { code: 'UJ-L1', expiryDate: expiresIn(300) });
      const id = await order([{ skuCode: 'D-UJ', quantity: 2 }], GSTIN.PCT);
      const [line] = linesOf(await wave([id]));
      expect(sliceText([line!])).toEqual(['short:2:consignee-unjudgeable']);
      expect(await stored(line!.id)).toMatchObject({ consignee_partner_id: partner('PCT').id, consignee_min_shelf_life_days: null, consignee_min_shelf_life_percent: 70 });
      const read = await shelfLifeOf(id).expect(200);
      expect(read.body.orderShelfLife.lines[0]).toMatchObject({ skuCode: 'D-UJ', judgeable: false, effectiveMinDays: null, shelfLifeBaseDays: null, qualifyingOnHand: 0, shortfallQty: 2, shortfallCause: 'consignee-unjudgeable' });
    });

    it('A1: an undated batch of a tracked SKU never ships to the consignee (cause consignee-shelf-life); unattributed units go to a B2C line only', async () => {
      await seed('D-UND', 'A-01', 5, { code: 'UN-L1' });
      const und = await order([{ skuCode: 'D-UND', quantity: 2 }], GSTIN.DMART);
      expect(sliceText(linesOf(await wave([und])))).toEqual(['short:2:consignee-shelf-life']);

      await seed('D-LESS', 'A-01', 10, { code: 'LS-L1', expiryDate: expiresIn(300) });
      // Make the bin's 10 units UNATTRIBUTED (the batch fold no longer covers them).
      await sql`delete from batch_on_hand where tenant_id = ${tenantId} and sku_id = ${sku('D-LESS')}`;
      const dmart = await order([{ skuCode: 'D-LESS', quantity: 3 }], GSTIN.DMART);
      const b2c = await order([{ skuCode: 'D-LESS', quantity: 3 }]);
      const w = await wave([dmart, b2c]);
      expect(sliceText(linesOf(w, dmart))).toEqual(['short:3:consignee-shelf-life']);
      expect(linesOf(w, b2c)).toMatchObject([{ status: 'planned', binCode: 'A-01', batchId: null, qty: 3 }]);
    });

    it('untracked SKU: walk order, unlimited and unstamped', async () => {
      await seed('D-UNTRK', 'B-01', 5);
      const id = await order([{ skuCode: 'D-UNTRK', quantity: 2 }], GSTIN.DMART);
      const [line] = linesOf(await wave([id]));
      expect(line).toMatchObject({ status: 'planned', binCode: 'B-01', qty: 2, consigneeName: null, consigneeMinShelfLifeDays: null });
    });

    it('another client: DMart\'s GSTIN on an order of a client DMart is not linked to — no consignee rule', async () => {
      await seed('X-OTHER', 'A-01', 5, { code: 'XO-L1', expiryDate: expiresIn(30) });
      const id = await order([{ skuCode: 'X-OTHER', quantity: 2 }], GSTIN.DMART);
      const [line] = linesOf(await wave([id]));
      expect(line).toMatchObject({ status: 'planned', batchCode: 'XO-L1', consigneeName: null });
      expect((await shelfLifeOf(id).expect(200)).body.orderShelfLife).toMatchObject({ consigneeResolution: 'no-consignee-link', consignee: null });
    });

    it('a switched-off link still applies its rule; a partner that lost the consignee role still applies it (resolution: applied)', async () => {
      // INACT's link was switched off above (with its 120-day rule).
      await seed('D-INACT', 'A-01', 5, { code: 'IN-L1', expiryDate: expiresIn(60) });
      const inact = await order([{ skuCode: 'D-INACT', quantity: 2 }], GSTIN.INACT);
      expect(sliceText(linesOf(await wave([inact])))).toEqual(['short:2:consignee-shelf-life']);

      await sql`update business_partners set roles = '{vendor}' where tenant_id = ${tenantId} and id = ${partner('ROLE').id}`;
      await seed('D-ROLE', 'A-01', 5, { code: 'RO-L1', expiryDate: expiresIn(60) });
      const role = await order([{ skuCode: 'D-ROLE', quantity: 2 }], GSTIN.ROLE);
      expect(sliceText(linesOf(await wave([role])))).toEqual(['short:2:consignee-shelf-life']);
      expect((await shelfLifeOf(role).expect(200)).body.orderShelfLife).toMatchObject({ consigneeResolution: 'applied', consignee: { code: 'ROLE' } });
    });

    it('a legacy order carrying a lowercase GSTIN is still matched (K11)', async () => {
      await seed('D-LOWER', 'A-01', 5, { code: 'LO-L1', expiryDate: expiresIn(60) });
      const id = await order([{ skuCode: 'D-LOWER', quantity: 2 }], GSTIN.DMART);
      await sql`update orders set consignee_gstin = lower(consignee_gstin) where id = ${id}`;
      expect(sliceText(linesOf(await wave([id])))).toEqual(['short:2:consignee-shelf-life']);
    });

    it('a whitespace-padded GSTIN resolves too: both resolvers match on trim + uppercase (the orders CHECK refuses padding today; the resolver does not rely on it)', async () => {
      expect(normalizeOrderGstin(`  ${GSTIN.DMART.toLowerCase()} `)).toBe(GSTIN.DMART);
      const rules = await withTenantTransaction(app.get<Database>(DATABASE), tenantId, (tx) =>
        consigneeShelfLifeRulesInTx(tx, tenantId, [{ clientId: client('BRAND'), gstin: `  ${GSTIN.DMART.toLowerCase()} ` }]),
      );
      expect(rules.get(consigneeRuleKey(client('BRAND'), ` ${GSTIN.DMART} `))).toMatchObject({ partnerCode: 'DMART', minShelfLifeDays: 120 });
    });

    it('A11: an order attributed to another client than its SKUs refuses the wave (5xx) and writes nothing', async () => {
      await seed('A-A11', 'A-01', 5, { code: 'AE-L1', expiryDate: expiresIn(200) });
      const id = await order([{ skuCode: 'A-A11', quantity: 2 }], GSTIN.DMART);
      await sql`update orders set client_id = ${client('OTHER')} where id = ${id}`;
      try {
        const before = (await sql`select count(*)::int as n from waves where tenant_id = ${tenantId}`)[0]!.n as number;
        const res = await generate([id], await wavePolicy());
        expect(res.status).toBeGreaterThanOrEqual(500);
        expect((await sql`select count(*)::int as n from waves where tenant_id = ${tenantId}`)[0]!.n).toBe(before);
        expect(await sql`select 1 from picklist_lines where order_id = ${id}`).toHaveLength(0);
      } finally {
        await sql`update orders set client_id = ${client('BRAND')} where id = ${id}`;
      }
    });

    it('two constrained orders in one wave: each line judged by its own consignee (DMart 120, Percent Mart 126)', async () => {
      await seed('D-TWO', 'A-01', 5, { code: 'TW-L1', expiryDate: expiresIn(122) });
      await seed('D-TWO', 'B-01', 5, { code: 'TW-L2', expiryDate: expiresIn(200) });
      const pct = await order([{ skuCode: 'D-TWO', quantity: 5 }], GSTIN.PCT);
      const dmart = await order([{ skuCode: 'D-TWO', quantity: 5 }], GSTIN.DMART);
      const w = await wave([pct, dmart]);
      // Percent Mart (first) cannot use the 122-day lot; DMart can.
      expect(sliceText(linesOf(w, pct))).toEqual(['TW-L2:5']);
      expect(sliceText(linesOf(w, dmart))).toEqual(['TW-L1:5']);
    });

    it('a kit\'s component lines of a consignee order are judged by the consignee', async () => {
      await http()
        .post(`${API}/${tenantId}/catalog/skus/${sku('K-KIT')}/kit`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ components: [{ skuId: sku('K-COMP'), quantity: 2 }] })
        .expect(201);
      await seed('K-COMP', 'A-01', 10, { code: 'KC-L1', expiryDate: expiresIn(60) });
      await seed('K-COMP', 'B-01', 10, { code: 'KC-L2', expiryDate: expiresIn(200) });
      const id = await order([{ skuCode: 'K-KIT', quantity: 2 }], GSTIN.DMART);
      const lines = linesOf(await wave([id]));
      expect(sliceText(lines)).toEqual(['KC-L2:4']);
      expect(lines[0]).toMatchObject({ skuId: sku('K-COMP'), consigneeMinShelfLifeDays: 120 });
    });

    it('a fractional line across a qualifying boundary: the short-life lot is skipped, the need spans the two qualifying lots', async () => {
      await seed('D-KG', 'A-01', 1.2, { code: 'KG-SHORT', expiryDate: expiresIn(60) });
      await seed('D-KG', 'A-01', 1, { code: 'KG-OK1', expiryDate: expiresIn(130) });
      await seed('D-KG', 'B-01', 5, { code: 'KG-OK2', expiryDate: expiresIn(200) });
      const id = await order([{ skuCode: 'D-KG', quantity: 2.5 }], GSTIN.DMART);
      expect(sliceText(linesOf(await wave([id])))).toEqual(['KG-OK1:1', 'KG-OK2:1.5']);
    });

    it('2-4b: a batch with a DERIVED expiry is a dated batch, judged on its stored date', async () => {
      await seed('D-DERIV', 'A-01', 5, { code: 'DV-L1', expiryDate: expiresIn(200) });
      await sql`update batches set expiry_source = 'derived' where tenant_id = ${tenantId} and code = 'DV-L1'`;
      const id = await order([{ skuCode: 'D-DERIV', quantity: 2 }], GSTIN.DMART);
      expect(sliceText(linesOf(await wave([id])))).toEqual(['DV-L1:2']);
    });

    it('a WaveSnapshot stored before 4-3b replays unchanged — its lines without the five new keys', async () => {
      await seed('W-SNAP', 'A-01', 5, { code: 'WS-L1', expiryDate: expiresIn(200) });
      const id = await order([{ skuCode: 'W-SNAP', quantity: 1 }], GSTIN.DMART);
      const policyId = await wavePolicy();
      const key = ulid();
      const fresh = await generate([id], policyId, key).expect(201);
      expect(fresh.body.wave.picklists[0].lines[0]).toMatchObject({ consigneeName: 'DMart Avenue', consigneeMinShelfLifeDays: 120 });
      await sql`update idempotency_keys set response_snapshot = jsonb_set(response_snapshot, '{wave,picklists,0,lines,0}',
          (response_snapshot #> '{wave,picklists,0,lines,0}') - 'consigneeName' - 'consigneeMinShelfLifeDays' - 'consigneeMinShelfLifePercent' - 'consigneeShelfLifeBaseDays' - 'shortfallCause')
        where tenant_id = ${tenantId} and key = ${key}`;
      const replay = await generate([id], policyId, key).expect(201);
      const line = replay.body.wave.picklists[0].lines[0] as Record<string, unknown>;
      for (const k of ['consigneeName', 'consigneeMinShelfLifeDays', 'consigneeMinShelfLifePercent', 'consigneeShelfLifeBaseDays', 'shortfallCause']) {
        expect(line).not.toHaveProperty(k);
      }
    });
  });

  // ── frozen lines ──────────────────────────────────────────────────────────

  describe('a rule edited mid-wave', () => {
    it('the open line keeps its frozen 120 and picks a 130-day lot; the next wave plans with 150 and refuses it', async () => {
      await seed('E-EDIT', 'A-01', 10, { code: 'ED-L1', expiryDate: expiresIn(130) });
      const first = await order([{ skuCode: 'E-EDIT', quantity: 3 }], GSTIN.EDIT);
      const [line] = linesOf(await wave([first]));
      expect(line).toMatchObject({ batchCode: 'ED-L1', consigneeMinShelfLifeDays: 120 });
      await putShelfLife('EDIT', 'BRAND', { minShelfLifeDays: 150, minShelfLifePercent: null }).expect(200);
      await pick(line!).expect(201);
      expect(await drawnBatchCodes(line!.id)).toEqual([{ code: 'ED-L1', qty: 3 }]);
      const next = await order([{ skuCode: 'E-EDIT', quantity: 3 }], GSTIN.EDIT);
      expect(sliceText(linesOf(await wave([next])))).toEqual(['short:3:consignee-shelf-life']);
    });
  });

  // ── the pick draw ─────────────────────────────────────────────────────────

  describe('the pick draw', () => {
    it('frozen consignee 120: when the named lot became unallocatable, the bin is re-ranked and the 60-day lot is skipped for the 300-day one', async () => {
      await seed('P-IN', 'A-01', 5, { code: 'PI-L2', expiryDate: expiresIn(200) });
      const id = await order([{ skuCode: 'P-IN', quantity: 3 }], GSTIN.DMART);
      const [line] = linesOf(await wave([id]));
      expect(line).toMatchObject({ batchCode: 'PI-L2' });
      await seed('P-IN', 'A-01', 5, { code: 'PI-L1', expiryDate: expiresIn(60) });
      await seed('P-IN', 'A-01', 5, { code: 'PI-L3', expiryDate: expiresIn(300) });
      await blockBatch('PI-L2');
      await pick(line!).expect(201);
      expect(await drawnBatchCodes(line!.id)).toEqual([{ code: 'PI-L3', qty: 3 }]);
    });

    it('only short-life stock in the bin: 422 insufficient-on-hand (epoch unmoved) / 409 pick-bin-short (moved), naming the consignee and its minimum; nothing recorded', async () => {
      await seed('P-ONLY', 'A-01', 3, { code: 'PO-L2', expiryDate: expiresIn(200) });
      const [line] = linesOf(await wave([await order([{ skuCode: 'P-ONLY', quantity: 3 }], GSTIN.DMART)]));
      await http()
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: wh, skuId: sku('P-ONLY'), binId: bin('A-01'), quantityDelta: -3, reasonCode: 'stock-count', note: 'drain' })
        .expect(201);
      await seed('P-ONLY', 'A-01', 10, { code: 'PO-L1', expiryDate: expiresIn(60) });
      const unmoved = await pick(line!).expect(422);
      expect(unmoved.body.code).toBe('insufficient-on-hand');
      expect(unmoved.body.detail).toContain("holds 0 drawable unit(s) of this SKU — 10 more are below consignee DMart Avenue's minimum remaining shelf life of 120 days; the pick draws 3");
      const moved = await pick(line!, { binStateEpoch: 999_999 }).expect(409);
      expect(moved.body.code).toBe('pick-bin-short');
      expect(moved.body.detail).toContain("below consignee DMart Avenue's minimum remaining shelf life of 120 days");
      expect(await drawnBatchCodes(line!.id)).toEqual([]);
      expect(await sql`select 1 from picks where tenant_id = ${tenantId} and picklist_line_id = ${line!.id}`).toHaveLength(0);
    });

    it('a tie (client 120, consignee 120) names the consignee; a stricter client (150 over 120) names the client', async () => {
      await seed('T-TIE', 'A-01', 3, { code: 'TT-L2', expiryDate: expiresIn(200) });
      const [tie] = linesOf(await wave([await order([{ skuCode: 'T-TIE', quantity: 3 }], GSTIN.DMART)]));
      await http()
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: wh, skuId: sku('T-TIE'), binId: bin('A-01'), quantityDelta: -3, reasonCode: 'stock-count', note: 'drain' })
        .expect(201);
      await seed('T-TIE', 'A-01', 4, { code: 'TT-L1', expiryDate: expiresIn(60) });
      expect((await pick(tie!).expect(422)).body.detail).toContain("4 more are below consignee DMart Avenue's minimum remaining shelf life of 120 days");

      await seed('C-PICK', 'A-01', 3, { code: 'CP-L2', expiryDate: expiresIn(200) });
      const [strict] = linesOf(await wave([await order([{ skuCode: 'C-PICK', quantity: 3 }], GSTIN.DMART)]));
      await http()
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: wh, skuId: sku('C-PICK'), binId: bin('A-01'), quantityDelta: -3, reasonCode: 'stock-count', note: 'drain' })
        .expect(201);
      await seed('C-PICK', 'A-01', 4, { code: 'CP-L1', expiryDate: expiresIn(140) });
      expect((await pick(strict!).expect(422)).body.detail).toContain("4 more are below client CMIN's minimum remaining shelf life of 150 days");
    });

    it('A3: an unjudgeable line refuses every dated lot — "cannot be shown to meet … (SKU has no total shelf life)"', async () => {
      await seed('P-UJ', 'A-01', 5, { code: 'PU-L1', expiryDate: expiresIn(300) });
      const [line] = linesOf(await wave([await order([{ skuCode: 'P-UJ', quantity: 2 }], GSTIN.DMART)]));
      // The unjudgeable shape (A3): partner + percent, days NULL.
      await sql`update picklist_lines set consignee_min_shelf_life_days = null, consignee_min_shelf_life_percent = 70 where id = ${line!.id}`;
      const refused = await pick(line!).expect(422);
      expect(refused.body.detail).toContain("5 more cannot be shown to meet DMart Avenue's shelf-life rule (P-UJ has no total shelf life)");
    });

    it('stricter client (150), consignee-only exclusion (an undated lot): the refusal names the consignee, not the client', async () => {
      await seed('C-UND', 'A-01', 3, { code: 'CU-L2', expiryDate: expiresIn(200) });
      const [line] = linesOf(await wave([await order([{ skuCode: 'C-UND', quantity: 3 }], GSTIN.DMART)]));
      await http()
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: wh, skuId: sku('C-UND'), binId: bin('A-01'), quantityDelta: -3, reasonCode: 'stock-count', note: 'drain' })
        .expect(201);
      await seed('C-UND', 'A-01', 4, { code: 'CU-UND' });
      const refused = await pick(line!).expect(422);
      expect(refused.body.detail).toContain("4 more are below consignee DMart Avenue's minimum remaining shelf life of 120 days");
      expect(refused.body.detail).not.toContain('below client');
    });

    it('A1 at the pick: unattributed units of a tracked SKU are counted in the consignee refusal', async () => {
      await seed('P-LESS', 'A-01', 3, { code: 'PL-L2', expiryDate: expiresIn(200) });
      const [line] = linesOf(await wave([await order([{ skuCode: 'P-LESS', quantity: 3 }], GSTIN.DMART)]));
      await http()
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: wh, skuId: sku('P-LESS'), binId: bin('A-01'), quantityDelta: -3, reasonCode: 'stock-count', note: 'drain' })
        .expect(201);
      await seed('P-LESS', 'A-01', 4, { code: 'PL-L3', expiryDate: expiresIn(300) });
      await sql`delete from batch_on_hand where tenant_id = ${tenantId} and sku_id = ${sku('P-LESS')}`;
      const refused = await pick(line!).expect(422);
      expect(refused.body.detail).toContain("— 4 more are below consignee DMart Avenue's minimum remaining shelf life of 120 days");
    });

    it('the consignee minimum takes the one-day grace (A3): planned yesterday with exactly 120 days left, the pick draws it', async () => {
      await seed('G-GRACE', 'A-01', 5, { code: 'GG-1', expiryDate: expiresIn(119) });
      batchExpiryClock.now = () => istTen(-1).getTime();
      const id = await order([{ skuCode: 'G-GRACE', quantity: 2 }], GSTIN.DMART);
      const [line] = linesOf(await wave([id], { at: istTen(-1) }));
      expect(line).toMatchObject({ batchCode: 'GG-1', consigneeMinShelfLifeDays: 120 });
      await sql`update picklists set created_at = ${istTen(-1).toISOString()} where id = ${line!.picklistId}`;
      batchExpiryClock.now = () => Date.now();
      await pick(line!).expect(201);
      expect(await drawnBatchCodes(line!.id)).toEqual([{ code: 'GG-1', qty: 2 }]);
    });

    it('grace capped: planned three days ago with exactly 120 days left, the pick refuses with the consignee suffix', async () => {
      await seed('G-CAP', 'A-01', 5, { code: 'GC-1', expiryDate: expiresIn(117) });
      batchExpiryClock.now = () => istTen(-3).getTime();
      const id = await order([{ skuCode: 'G-CAP', quantity: 2 }], GSTIN.DMART);
      const [line] = linesOf(await wave([id], { at: istTen(-3) }));
      expect(line).toMatchObject({ batchCode: 'GC-1' });
      await sql`update picklists set created_at = ${istTen(-3).toISOString()} where id = ${line!.picklistId}`;
      batchExpiryClock.now = () => Date.now();
      const refused = await pick(line!).expect(422);
      expect(refused.body.detail).toContain("5 more are below consignee DMart Avenue's minimum remaining shelf life of 120 days");
    });

    it('A12: another order\'s claim on a bin is charged to the short-life slot first — by the order read and by the re-plan', async () => {
      await seed('A-CLAIM', 'A-01', 5, { code: 'AC-SHORT', expiryDate: expiresIn(60) });
      await seed('A-CLAIM', 'C-01', 5, { code: 'AC-PLAN', expiryDate: expiresIn(300) });
      const b2c = await order([{ skuCode: 'A-CLAIM', quantity: 5 }]);
      expect(sliceText(linesOf(await wave([b2c], { release: false })))).toEqual(['AC-SHORT:5']);
      const dmart = await order([{ skuCode: 'A-CLAIM', quantity: 5 }], GSTIN.DMART);
      const [line] = linesOf(await wave([dmart]));
      expect(sliceText([line!])).toEqual(['AC-PLAN:5']);
      await seed('A-CLAIM', 'A-01', 5, { code: 'AC-OK', expiryDate: expiresIn(200) });
      // The B2C claim (5 in A-01) lands on AC-SHORT, ranked first: AC-OK and
      // the order's own AC-PLAN still qualify.
      expect((await shelfLifeOf(dmart).expect(200)).body.orderShelfLife.lines[0]).toMatchObject({ qualifyingOnHand: 10, qualifyingUnclaimed: 10 });
      const res = await pick(line!, { qty: 0, reasonCode: 'bin-empty' }).expect(201);
      expect((res.body.pick.replanned as { binCode: string; qty: number }[]).map((s) => `${s.binCode}:${s.qty}`)).toEqual(['A-01:5']);
    });

    it('a short pick re-plans under the frozen consignee rule: the 60-day lot is skipped, and the new slice copies the consignee columns', async () => {
      await seed('R-RP', 'C-01', 4, { code: 'RR-PLAN', expiryDate: expiresIn(300) });
      const [line] = linesOf(await wave([await order([{ skuCode: 'R-RP', quantity: 4 }], GSTIN.DMART)]));
      expect(line).toMatchObject({ binCode: 'C-01' });
      await seed('R-RP', 'A-01', 10, { code: 'RR-SHORT', expiryDate: expiresIn(60) });
      await seed('R-RP', 'B-01', 10, { code: 'RR-OK', expiryDate: expiresIn(200) });
      const res = await pick(line!, { qty: 0, reasonCode: 'bin-empty' }).expect(201);
      const replanned = res.body.pick.replanned as { picklistLineId: string; binCode: string; qty: number }[];
      expect(replanned.map((s) => `${s.binCode}:${s.qty}`)).toEqual(['B-01:4']);
      expect(await stored(replanned[0]!.picklistLineId)).toMatchObject({
        consignee_partner_id: partner('DMART').id,
        consignee_min_shelf_life_days: 120,
        consignee_min_shelf_life_percent: null,
        shortfall_cause: null,
      });
    });

    it('A3 on the re-plan: an unjudgeable line re-plans nothing (every dated lot refused)', async () => {
      await seed('R-UJ', 'C-01', 3, { code: 'RU-PLAN', expiryDate: expiresIn(300) });
      const [line] = linesOf(await wave([await order([{ skuCode: 'R-UJ', quantity: 3 }], GSTIN.DMART)]));
      await sql`update picklist_lines set consignee_min_shelf_life_days = null, consignee_min_shelf_life_percent = 70 where id = ${line!.id}`;
      await seed('R-UJ', 'A-01', 5, { code: 'RU-OK', expiryDate: expiresIn(300) });
      const res = await pick(line!, { qty: 0, reasonCode: 'bin-empty' }).expect(201);
      expect(res.body.pick.replanned).toEqual([]);
    });
  });

  // ── the order read ────────────────────────────────────────────────────────

  describe('the order read', () => {
    it('a DMart order of two lines: the rule, per line the binding minimum and qualifying vs reserved (if waved today); 404 unknown', async () => {
      await seed('O-A', 'A-01', 10, { code: 'OA-L2', expiryDate: expiresIn(200) });
      await seed('O-A', 'B-01', 5, { code: 'OA-L1', expiryDate: expiresIn(60) });
      await seed('O-B', 'A-01', 4);
      const id = await order(
        [
          { skuCode: 'O-A', quantity: 6 },
          { skuCode: 'O-B', quantity: 2 },
        ],
        GSTIN.DMART,
      );
      const read = await shelfLifeOf(id).expect(200);
      expect(read.body.orderShelfLife).toMatchObject({
        orderId: id,
        judgedOn: today,
        clientMinShelfLifeDays: null,
        consigneeResolution: 'applied',
        consignee: { partnerId: partner('DMART').id, code: 'DMART', name: 'DMart Avenue', minShelfLifeDays: 120, minShelfLifePercent: null },
      });
      expect(read.body.orderShelfLife.lines).toEqual([
        {
          orderLineId: expect.any(String),
          skuId: sku('O-A'),
          skuCode: 'O-A',
          reservedQty: 6,
          effectiveMinDays: 120,
          shelfLifeBaseDays: null,
          judgeable: true,
          qualifyingOnHand: 10,
          qualifyingUnclaimed: 10,
          belowConsigneeMinimumOnHand: 5,
          plannedQty: null,
          shortfallQty: null,
          shortfallCause: null,
        },
        {
          orderLineId: expect.any(String),
          skuId: sku('O-B'),
          skuCode: 'O-B',
          reservedQty: 2,
          effectiveMinDays: null,
          shelfLifeBaseDays: null,
          judgeable: true,
          qualifyingOnHand: 4,
          qualifyingUnclaimed: 4,
          belowConsigneeMinimumOnHand: 0,
          plannedQty: null,
          shortfallQty: null,
          shortfallCause: null,
        },
      ]);
      await shelfLifeOf('01900000-0000-7000-8000-0000000000bb').expect(404);
      // Once waved, the line's plan rides along.
      linesOf(await wave([id], { release: false }));
      const after = (await shelfLifeOf(id).expect(200)).body.orderShelfLife.lines[0];
      // Its own planned lines are not claims: qualifyingUnclaimed is unchanged.
      expect(after).toMatchObject({ plannedQty: 6, shortfallQty: 0, shortfallCause: null, qualifyingOnHand: 10, qualifyingUnclaimed: 10 });
    });

    it('claimed elsewhere: 10 qualifying units all claimed by an earlier open wave → qualifyingOnHand 10, qualifyingUnclaimed 0', async () => {
      await seed('O-CL', 'A-01', 10, { code: 'OC-L1', expiryDate: expiresIn(200) });
      const b2c = await order([{ skuCode: 'O-CL', quantity: 10 }]);
      await wave([b2c], { release: false });
      const dmart = await order([{ skuCode: 'O-CL', quantity: 4 }], GSTIN.DMART);
      const line = (await shelfLifeOf(dmart).expect(200)).body.orderShelfLife.lines[0];
      expect(line).toMatchObject({ qualifyingOnHand: 10, qualifyingUnclaimed: 0, reservedQty: 0 });
    });

    it('a stricter client: clientMinShelfLifeDays 150 and the binding effectiveMinDays 150', async () => {
      await seed('C-READ', 'A-01', 5, { code: 'CR-L1', expiryDate: expiresIn(200) });
      const id = await order([{ skuCode: 'C-READ', quantity: 1 }], GSTIN.DMART);
      const read = (await shelfLifeOf(id).expect(200)).body.orderShelfLife;
      expect(read).toMatchObject({ clientMinShelfLifeDays: 150, consigneeResolution: 'applied', consignee: { code: 'DMART', minShelfLifeDays: 120 } });
      expect(read.lines[0]).toMatchObject({ effectiveMinDays: 150, qualifyingOnHand: 5 });
    });

    it('a kit order: the parent line is not listed; two lines of the same SKU are judged one after the other', async () => {
      const id = await order(
        [
          { skuCode: 'K-KIT', quantity: 1 },
          { skuCode: 'K-COMP', quantity: 3 },
        ],
        GSTIN.DMART,
      );
      const lines = (await shelfLifeOf(id).expect(200)).body.orderShelfLife.lines as { skuId: string; reservedQty: number; qualifyingOnHand: number }[];
      expect(lines.map((l) => l.skuId)).toEqual([sku('K-COMP'), sku('K-COMP')]);
      // KC-L2 holds 10 qualifying units: the earlier line takes its reservation first.
      const [first, second] = lines;
      expect(second!.qualifyingOnHand).toBe(first!.qualifyingOnHand - first!.reservedQty);
      expect(first!.qualifyingOnHand).toBe(10);
    });

    it('a client-portal session is refused (an operator surface)', async () => {
      const portal = await inviteAndSignIn('client', 'portal-password-123', client('BRAND'));
      const id = await order([{ skuCode: 'O-B', quantity: 1 }], GSTIN.DMART);
      const refused = await shelfLifeOf(id, portal).expect(403);
      expect(refused.body.detail).toBe('This is an operator surface.');
    });

    it('the resolution names why a rule did not apply: no-gstin, no-partner, no-consignee-link, no-rule', async () => {
      await seed('O-B', 'B-01', 20);
      const cases: [string | undefined, string][] = [
        [undefined, 'no-gstin'],
        [GSTIN.UNKNOWN, 'no-partner'],
        [GSTIN.NOLINK, 'no-consignee-link'],
        [GSTIN.NORULE, 'no-rule'],
      ];
      for (const [gstin, resolution] of cases) {
        const id = await order([{ skuCode: 'O-B', quantity: 1 }], gstin);
        expect((await shelfLifeOf(id).expect(200)).body.orderShelfLife).toMatchObject({
          consigneeResolution: resolution,
          consignee: null,
          consigneeGstin: gstin ?? null,
          resolvedPartner: resolution === 'no-consignee-link' ? { code: 'NOLINK' } : resolution === 'no-rule' ? { code: 'NORULE' } : null,
        });
      }
    });
  });

  /** Waits until `min` requests are parked on the partner row lock held by `holderPid`. */
  async function waitParked(holderPid: number, min: number): Promise<void> {
    const probe = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const waiting = (await probe`
          select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
          where a.wait_event_type = 'Lock' and a.state = 'active'
            and a.query ilike '%"business_partners"%' and a.query ilike '%for no key update%'
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
      throw new Error(`fewer than ${min} request(s) parked on the partner row`);
    } finally {
      await probe.end();
    }
  }

});
