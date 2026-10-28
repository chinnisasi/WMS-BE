import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { addIsoDays, istDateOf, istMidnightOf } from '../src/shared/primitives/time';
import { batchExpiryClock } from '../src/shared/primitives/batch-expiry';
import {
  ALLOCATION_RULES,
  MIN_OUTBOUND_SHELF_LIFE_DAYS_MAX,
  MIN_OUTBOUND_SHELF_LIFE_DAYS_MIN,
} from '../src/modules/clients/clients.schema';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { WAVE_CLOCK, type WaveClock } from '../src/modules/outbound/wave.clock';
import { picklistLineInsertTuning } from '../src/modules/outbound/wave.command';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow, noOpIdempotencyKey } from './support/audit-guard';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';

/**
 * Story 4-3a — client allocation rules: FEFO / FIFO and a minimum remaining
 * shelf life at dispatch, on the client policy row, applied by the wave plan,
 * the short-pick re-plan, the pick draw and ATP. Every matrix row of the spec
 * (frozen and amended) is driven through HTTP here; the pure ranking, the
 * predicate, the leap-year boundary and the chunk arithmetic are unit-tested
 * in `test/batch-allocation.spec.ts`.
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
const DAY = 86_400_000;

interface Line {
  id: string;
  picklistId: string;
  orderId: string;
  orderLineId: string;
  skuId: string;
  binId: string | null;
  binCode: string | null;
  batchId: string | null;
  qty: number;
  shortfallQty: number;
  sliceSeq: number;
  walkSeq: number;
  status: string;
  batchCode?: string | null;
  batchExpiryDate?: string | null;
  batchReceivedOn?: string | null;
  allocationRule?: string | null;
  minOutboundShelfLifeDays?: number | null;
}
interface WaveBody {
  id: string;
  picklists: { id: string; orderId: string | null; lines: Line[] }[];
}

describe('story 4-3a: client allocation rules (e2e)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let suiteDb: SuiteDatabase;
  let inventory: InventoryFacade;
  let tenantId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let opsToken: string;
  let operatorToken: string;
  let wh: string;
  let zoneId: string;
  let selfClient: string;
  const bins = new Map<string, string>();
  const clientIds = new Map<string, string>();
  const skuIds = new Map<string, string>();
  /** Today's IST date at suite start — every relative fixture date keys on it. */
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
  /** The stored expiry instant of a lot labelled "expires today + n days". */
  const expiresIn = (days: number) => istMidnightOf(addIsoDays(today, days));
  /** 10:00 IST on today + n days. */
  const istTen = (days: number) => new Date(Date.parse(`${addIsoDays(today, days)}T04:30:00.000Z`));

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('allocation_rules');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });
    inventory = app.get(InventoryFacade);
    today = istDateOf(new Date().toISOString());

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Alloc Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    const signedIn = await mintSignIn(app, { email, password: 'correct-horse-battery' });
    ownerToken = signedIn.body.accessToken as string;
    ownerUserId = signedIn.body.user.id as string;
    opsToken = await inviteAndSignIn('ops_manager', 'ops-password-123');

    wh = (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `AL-${ulid().slice(20)}`, name: 'Alloc warehouse' })
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
    // Created out of code order on purpose: the walk is code order.
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

    const listed = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    selfClient = (listed.body.items as { id: string; systemOwned: boolean }[]).find((c) => c.systemOwned)!.id;
    clientIds.set('SELF', selfClient);
    for (const code of ['FEFO', 'FIFO', 'MIN', 'FIFO90', 'EDIT', 'RAISE', 'POL', 'TWO']) {
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
    await importSkus('FEFO', [
      ['F-XBIN', 'pcs', true],
      ['F-UNDATED', 'pcs', true],
      ['F-SPAN', 'pcs', true],
      ['F-UNTRK', 'pcs', false],
      ['F-REPLAN', 'pcs', true],
      ['F-KG', 'kg', true],
      ['F-LEGACY', 'pcs', true],
      ['F-URGENT', 'pcs', true],
      ['F-CHUNK1', 'pcs', false],
      ['F-CHUNK2', 'pcs', false],
      ['F-TASK', 'pcs', true],
    ]);
    await importSkus('FIFO', [['I-ROT', 'pcs', true]]);
    await importSkus('MIN', [
      ['M-MIN', 'pcs', true],
      ['M-EDGE', 'pcs', true],
      ['M-UNDATED', 'pcs', true],
      ['M-UNTRK', 'pcs', false],
      ['M-INBIN', 'pcs', true],
      ['M-ONLY', 'pcs', true],
      ['M-GRACE', 'pcs', true],
      ['M-CAP', 'pcs', true],
      ['M-EXP', 'pcs', true],
      ['M-BUF', 'pcs', true],
      ['M-RGRACE', 'pcs', true],
    ]);
    await importSkus('FIFO90', [
      ['Q-REPLAN', 'pcs', true],
      ['Q-LEGACY', 'pcs', true],
    ]);
    await importSkus('EDIT', [['E-FROZEN', 'pcs', true]]);
    await importSkus('RAISE', [['R-RAISE', 'pcs', true]]);
    await importSkus('POL', [
      ['P-U1', 'pcs', false],
      ['P-B1', 'pcs', true],
      ['P-B2', 'pcs', true],
    ]);
    await importSkus('TWO', [['T-TWO', 'pcs', true]]);

    // The policies the scenarios run under (the PUT itself is tested below).
    await putPolicy(client('FIFO'), { allocationRule: 'fifo', minOutboundShelfLifeDays: null }).expect(200);
    await putPolicy(client('MIN'), { allocationRule: 'fefo', minOutboundShelfLifeDays: 90 }).expect(200);
    await putPolicy(client('FIFO90'), { allocationRule: 'fifo', minOutboundShelfLifeDays: 90 }).expect(200);

    // The handheld: one enrolled device and its badge-in operator.
    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Alloc scanner', pin: '1357' })
      .expect(201);
    const operatorEmail = `operator-${ulid().toLowerCase()}@example.com`;
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
    picklistLineInsertTuning.maxBindParams = 65_535;
    picklistLineInsertTuning.onChunk = undefined;
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

  function putPolicy(clientId: string, body: Record<string, unknown>, key = ulid(), token = ownerToken) {
    return http()
      .put(`${API}/${tenantId}/clients/${clientId}/allocation-policy`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function getPolicy(clientId: string, token = opsToken) {
    return http().get(`${API}/${tenantId}/clients/${clientId}/allocation-policy`).set('Authorization', `Bearer ${token}`);
  }

  /**
   * Seeds on-hand through the adjustment command, optionally into a batch with
   * an expiry; `receivedDaysAgo` back-dates the lot's FIRST receipt
   * (`batches.created_at` — the FIFO anchor; a DB fixture, nothing writes it).
   */
  async function seed(
    skuCode: string,
    binCode: string,
    quantity: number,
    batch?: { code: string; expiryDate?: string | null; receivedDaysAgo?: number },
  ): Promise<void> {
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
        note: 'allocation-rules seed',
        ...(batch === undefined
          ? {}
          : { batch: { code: batch.code, ...(batch.expiryDate == null ? {} : { expiryDate: batch.expiryDate }) } }),
      })
      .expect(201);
    if (batch?.receivedDaysAgo !== undefined) {
      await sql`update batches set created_at = ${new Date(Date.now() - batch.receivedDaysAgo * DAY).toISOString()}
        where tenant_id = ${tenantId} and sku_id = ${sku(skuCode)} and code = ${batch.code}`;
    }
  }

  async function order(lines: { skuCode: string; quantity: number }[], extra: Record<string, unknown> = {}): Promise<string> {
    const res = await http()
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, lines: lines.map((l) => ({ skuId: sku(l.skuCode), quantity: l.quantity })), destination: testAddress(), ...extra })
      .expect(201);
    return res.body.order.id as string;
  }

  async function wavePolicy(grouping: 'single' | 'batch' = 'single'): Promise<string> {
    const res = await http()
      .post(`${API}/${tenantId}/outbound/wave-policies`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, name: `al-${ulid().slice(10, 20)}`, grouping })
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

  /** Generates a wave over the orders — at a stubbed wave clock when given — and returns it. */
  async function wave(orderIds: string[], opts: { at?: Date; grouping?: 'single' | 'batch'; release?: boolean } = {}): Promise<WaveBody> {
    const policyId = await wavePolicy(opts.grouping);
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
    return getWave(waveId);
  }

  async function getWave(waveId: string): Promise<WaveBody> {
    return (await http().get(`${API}/${tenantId}/outbound/waves/${waveId}`).set('Authorization', `Bearer ${opsToken}`).expect(200)).body
      .wave as WaveBody;
  }

  const linesOf = (w: WaveBody) => w.picklists.flatMap((p) => p.lines);

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

  async function atpOf(skuCode: string): Promise<number> {
    return (await inventory.atp(tenantId, wh, sku(skuCode))).atp / 1000;
  }

  // ── the vocabulary and the migration ──────────────────────────────────────

  describe('the schema', () => {
    it('ALLOCATION_RULES and the day bounds are pinned against the 0094 CHECKs (NOT VALID tolerated); the picklist_lines CHECKs are NOT VALID', async () => {
      const rows = (await sql`
        select conname, pg_get_constraintdef(oid) as def, convalidated
        from pg_constraint
        where conname in ('clients_allocation_rule_check', 'clients_min_outbound_shelf_life_range',
                          'picklist_lines_allocation_rule_check', 'picklist_lines_min_outbound_shelf_life_range',
                          'picklist_lines_allocation_pairing')
      `) as unknown as { conname: string; def: string; convalidated: boolean }[];
      const def = new Map(rows.map((row) => [row.conname, row.def.replace(/ NOT VALID$/, '')]));
      const literals = (text: string) => [...text.matchAll(/'([a-z]+)'::text/g)].map((m) => m[1]);
      expect(literals(def.get('clients_allocation_rule_check')!)).toEqual([...ALLOCATION_RULES]);
      expect(literals(def.get('picklist_lines_allocation_rule_check')!)).toEqual([...ALLOCATION_RULES]);
      for (const name of ['clients_min_outbound_shelf_life_range', 'picklist_lines_min_outbound_shelf_life_range']) {
        expect(def.get(name)).toContain(`>= ${MIN_OUTBOUND_SHELF_LIFE_DAYS_MIN}`);
        expect(def.get(name)).toContain(`<= ${MIN_OUTBOUND_SHELF_LIFE_DAYS_MAX}`);
      }
      expect(def.get('picklist_lines_allocation_pairing')).toContain('allocation_rule IS NOT NULL');
      expect(Object.fromEntries(rows.map((row) => [row.conname, row.convalidated]))).toEqual({
        clients_allocation_rule_check: true,
        clients_min_outbound_shelf_life_range: true,
        picklist_lines_allocation_rule_check: false,
        picklist_lines_min_outbound_shelf_life_range: false,
        picklist_lines_allocation_pairing: false,
      });
    });
  });

  // ── the policy write and its read ─────────────────────────────────────────

  describe('the policy on the client row', () => {
    it('every client starts fefo / no minimum (self included); the GET counts untracked SKUs and undated batches on hand', async () => {
      expect((await getPolicy(selfClient).expect(200)).body).toEqual({
        clientId: selfClient,
        allocationRule: 'fefo',
        minOutboundShelfLifeDays: null,
        untrackedSkuCount: 0,
        undatedBatchesOnHand: 0,
      });
      await seed('P-B1', 'A-01', 3, { code: 'P-UND-1' });
      await seed('P-B1', 'A-01', 3, { code: 'P-UND-2' });
      await seed('P-B1', 'A-01', 3, { code: 'P-DATED', expiryDate: expiresIn(200) });
      // Not counted: a BLOCKED undated lot, and one drained to zero.
      await seed('P-B1', 'A-01', 3, { code: 'P-UND-BLK' });
      const blockedId = (
        (await sql`select id from batches where tenant_id = ${tenantId} and code = 'P-UND-BLK'`) as unknown as { id: string }[]
      )[0]!.id;
      await http()
        .post(`${API}/${tenantId}/inventory/batches/${blockedId}/block`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ reason: 'recall' })
        .expect(201);
      // P-B2's only lot, drained to zero (the default draw takes it).
      await seed('P-B2', 'A-01', 3, { code: 'P-UND-ZERO' });
      await seed('P-B2', 'A-01', -3);
      const pol = await getPolicy(client('POL')).expect(200);
      expect(pol.body).toEqual({
        clientId: client('POL'),
        allocationRule: 'fefo',
        minOutboundShelfLifeDays: null,
        untrackedSkuCount: 1,
        undatedBatchesOnHand: 2,
      });
      // Every fresh client read carries it.
      const list = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      const fifo = (list.body.items as { id: string; allocationPolicy?: unknown }[]).find((c) => c.id === client('FIFO'));
      expect(fifo!.allocationPolicy).toEqual({ allocationRule: 'fifo', minOutboundShelfLifeDays: null });
    });

    it('an owner replaces it whole; audited; a replay re-serves; the same policy again is a no-op that stores its key; undated batches stay a warning, never a block', async () => {
      const body = { allocationRule: 'fifo', minOutboundShelfLifeDays: 90 };
      const key = ulid();
      const res = await putPolicy(client('POL'), body, key).expect(200);
      expect(res.body.client.allocationPolicy).toEqual(body);
      // The receiving policy is untouched.
      // Story 2-4b — the receiving policy gains the derivation switch (explicit pin update).
      expect(res.body.client.receivingPolicy).toEqual({ receivingToleranceBps: 0, qcOnReceipt: false, expiryRequired: false, minShelfLifeDays: null, deriveExpiry: true });
      await expectAuditRow({ tenantId, key, action: 'client.allocation_policy_updated', targetType: 'client', targetId: client('POL'), actorUserId: ownerUserId });
      const replay = await putPolicy(client('POL'), body, key).expect(200);
      expect(replay.body).toEqual(res.body);
      await expectAuditRow({ tenantId, key, action: 'client.allocation_policy_updated', targetType: 'client', targetId: client('POL'), actorUserId: ownerUserId });
      const reuse = await putPolicy(client('POL'), { ...body, minOutboundShelfLifeDays: 91 }, key).expect(422);
      expect(reuse.body.code).toBe('idempotency-key-reuse');

      const noOpKey = noOpIdempotencyKey(tenantId, ulid(), 'clients.allocationPolicy:unchanged');
      const unchanged = await putPolicy(client('POL'), body, noOpKey).expect(200);
      expect(unchanged.body.client.allocationPolicy).toEqual(body);
      expect(await sql`select 1 from audit_events where tenant_id = ${tenantId} and reference = ${noOpKey}`).toHaveLength(0);
      expect(await sql`select 1 from idempotency_keys where tenant_id = ${tenantId} and key = ${noOpKey}`).toHaveLength(1);

      // A minimum with `expiryRequired` false and undated stock on hand: the
      // GET reads the count the panel warns with; the save was allowed.
      expect((await getPolicy(client('POL')).expect(200)).body).toMatchObject({ minOutboundShelfLifeDays: 90, undatedBatchesOnHand: 2 });
      // An explicit null clears the minimum.
      await putPolicy(client('POL'), { allocationRule: 'fefo', minOutboundShelfLifeDays: null }).expect(200);
    });

    it('each bad body is a 400 validation-failed naming its field — a missing key included — and nothing changes', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ allocationRule: 'lifo', minOutboundShelfLifeDays: null }, 'allocationRule'],
        [{ allocationRule: 'fefo', minOutboundShelfLifeDays: 0 }, 'minOutboundShelfLifeDays'],
        [{ allocationRule: 'fefo', minOutboundShelfLifeDays: 3651 }, 'minOutboundShelfLifeDays'],
        [{ allocationRule: 'fefo', minOutboundShelfLifeDays: 1.5 }, 'minOutboundShelfLifeDays'],
        [{ allocationRule: 'fefo' }, 'minOutboundShelfLifeDays'],
        [{ minOutboundShelfLifeDays: 10 }, 'allocationRule'],
      ];
      for (const [body, field] of cases) {
        const res = await putPolicy(client('POL'), body).expect(400);
        expect(res.body.code).toBe('validation-failed');
        expect(res.body.detail).toContain(field);
      }
      // The command itself re-checks behind the replay lookup (the DTO is not the boundary).
      const { assertAllocationPolicy } = await import('../src/modules/clients/clients.command');
      for (const [body, field] of cases) {
        expect(() => assertAllocationPolicy(body as never)).toThrow(expect.objectContaining({ message: expect.stringContaining(field) }));
      }
      expect((await getPolicy(client('POL')).expect(200)).body).toMatchObject({ allocationRule: 'fefo', minOutboundShelfLifeDays: null });
    });

    it('only the owner writes (403 role-denied for an ops manager); an unknown client is 404; the self client behaves like any other', async () => {
      const denied = await putPolicy(client('POL'), { allocationRule: 'fifo', minOutboundShelfLifeDays: null }, ulid(), opsToken).expect(403);
      expect(denied.body.code).toBe('role-denied');
      await putPolicy('01900000-0000-7000-8000-00000000abcd', { allocationRule: 'fifo', minOutboundShelfLifeDays: null }).expect(404);
      await getPolicy('01900000-0000-7000-8000-00000000abcd').expect(404);
      // A departed client's policy stays editable (a policy is not work).
      const goneId = (
        await http().post(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code: 'GONE', name: 'Gone Brand' }).expect(201)
      ).body.client.id as string;
      await http()
        .patch(`${API}/${tenantId}/clients/${goneId}/status`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ status: 'departed' })
        .expect(200);
      expect((await putPolicy(goneId, { allocationRule: 'fifo', minOutboundShelfLifeDays: 10 }).expect(200)).body.client).toMatchObject({
        status: 'departed',
        allocationPolicy: { allocationRule: 'fifo', minOutboundShelfLifeDays: 10 },
      });
      const self = await putPolicy(selfClient, { allocationRule: 'fifo', minOutboundShelfLifeDays: 30 }).expect(200);
      expect(self.body.client.allocationPolicy).toEqual({ allocationRule: 'fifo', minOutboundShelfLifeDays: 30 });
      await putPolicy(selfClient, { allocationRule: 'fefo', minOutboundShelfLifeDays: null }).expect(200);
    });

    it('a same-key race parked on the client lock answers both requests with the winner\'s snapshot, one audit row, one key', async () => {
      const key = ulid();
      const body = { allocationRule: 'fifo', minOutboundShelfLifeDays: 45 };
      const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
      let first: Promise<request.Response> | undefined;
      let second: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const locked = (await tx`select pg_backend_pid() as pid from clients where tenant_id = ${tenantId} and id = ${client('POL')} for update`) as unknown as {
            pid: number;
          }[];
          first = (async () => putPolicy(client('POL'), body, key))();
          second = (async () => putPolicy(client('POL'), body, key))();
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
      await putPolicy(client('POL'), { allocationRule: 'fefo', minOutboundShelfLifeDays: null }).expect(200);
    });

    it('a ClientMutationSnapshot stored before 4-3a replays unchanged — without allocationPolicy (the receiving PUT\'s request and hash are untouched)', async () => {
      const key = ulid();
      const body = { receivingToleranceBps: 100, qcOnReceipt: false, expiryRequired: false, minShelfLifeDays: null };
      const fresh = await http()
        .put(`${API}/${tenantId}/clients/${client('POL')}/receiving-policy`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, key)
        .send(body)
        .expect(200);
      expect(fresh.body.client.allocationPolicy).toEqual({ allocationRule: 'fefo', minOutboundShelfLifeDays: null });
      // Make the stored answer what a pre-4-3a build stored: no allocationPolicy.
      await sql`update idempotency_keys set response_snapshot = response_snapshot #- '{client,allocationPolicy}'
        where tenant_id = ${tenantId} and key = ${key}`;
      const replay = await http()
        .put(`${API}/${tenantId}/clients/${client('POL')}/receiving-policy`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, key)
        .send(body)
        .expect(200);
      expect(replay.body.client.allocationPolicy).toBeUndefined();
      // Story 2-4b — the stored answer was written by this build, so its policy carries the switch (explicit pin update).
      expect(replay.body.client.receivingPolicy).toEqual({ ...body, deriveExpiry: true });
    });

    it('the GET and the PUT are in the OpenAPI document with their documented arms', async () => {
      const doc = await http().get('/api/v1/openapi.json').expect(200);
      const path = (doc.body.paths as Record<string, Record<string, { responses: Record<string, unknown> }>>)['/tenants/{tenantId}/clients/{clientId}/allocation-policy'];
      expect(Object.keys(path!.get!.responses).sort()).toEqual(['200', '400', '401', '403', '404']);
      expect(Object.keys(path!.put!.responses).sort()).toEqual(['200', '400', '401', '403', '404', '409', '422']);
    });
  });

  /** Waits until `min` requests are parked on the client row lock held by `holderPid`. */
  async function waitParked(holderPid: number, min: number): Promise<void> {
    const probe = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const waiting = (await probe`
          select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
          where a.wait_event_type = 'Lock' and a.state = 'active'
            and a.query ilike '%"clients"%' and a.query ilike '%for no key update%'
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
      throw new Error(`fewer than ${min} request(s) parked on the client row`);
    } finally {
      await probe.end();
    }
  }

  // ── the wave plan ─────────────────────────────────────────────────────────

  describe('the wave plan', () => {
    it('FEFO across bins (AC backend): the 30-day lot in the later bin is planned and picked, not the 200-day lot in A-01; the line freezes fefo / null and prints the batch', async () => {
      await seed('F-XBIN', 'A-01', 10, { code: 'X-L2', expiryDate: expiresIn(200) });
      await seed('F-XBIN', 'B-01', 10, { code: 'X-L1', expiryDate: expiresIn(30) });
      const w = await wave([await order([{ skuCode: 'F-XBIN', quantity: 5 }])]);
      const [line] = linesOf(w);
      expect(line).toMatchObject({
        binCode: 'B-01',
        batchCode: 'X-L1',
        batchExpiryDate: addIsoDays(today, 30),
        batchReceivedOn: today,
        allocationRule: 'fefo',
        minOutboundShelfLifeDays: null,
        qty: 5,
      });
      await pick(line!).expect(201);
      expect(await drawnBatchCodes(line!.id)).toEqual([{ code: 'X-L1', qty: 5 }]);
    });

    it('FEFO, undated: the lot first received earlier (in B-01) ranks first', async () => {
      await seed('F-UNDATED', 'A-01', 5, { code: 'U-NEW', receivedDaysAgo: 1 });
      await seed('F-UNDATED', 'B-01', 5, { code: 'U-OLD', receivedDaysAgo: 60 });
      const [line] = linesOf(await wave([await order([{ skuCode: 'F-UNDATED', quantity: 3 }])], { release: false }));
      expect(line).toMatchObject({ binCode: 'B-01', batchCode: 'U-OLD', batchExpiryDate: null, batchReceivedOn: addIsoDays(today, -60) });
    });

    it('FIFO (AC): the lot first received earlier wins over a newer, sooner-expiring lot — and a lot received again keeps its first date', async () => {
      await seed('I-ROT', 'A-01', 10, { code: 'I-NEW', expiryDate: expiresIn(30) });
      await seed('I-ROT', 'B-01', 10, { code: 'I-OLD', expiryDate: expiresIn(300), receivedDaysAgo: 60 });
      // Received again today: the lot row (and its first receipt) is unchanged.
      await seed('I-ROT', 'B-01', 2, { code: 'I-OLD', expiryDate: expiresIn(300) });
      const [line] = linesOf(await wave([await order([{ skuCode: 'I-ROT', quantity: 5 }])], { release: false }));
      expect(line).toMatchObject({ binCode: 'B-01', batchCode: 'I-OLD', allocationRule: 'fifo', batchReceivedOn: addIsoDays(today, -60) });
    });

    it('spans batches: 15 over L1 (10, B-01) and L2 (10, A-01) plans L1 10 + L2 5, and the walk visits A-01 before B-01', async () => {
      await seed('F-SPAN', 'B-01', 10, { code: 'S-L1', expiryDate: expiresIn(30) });
      await seed('F-SPAN', 'A-01', 10, { code: 'S-L2', expiryDate: expiresIn(200) });
      const lines = linesOf(await wave([await order([{ skuCode: 'F-SPAN', quantity: 15 }])], { release: false }));
      const byWalk = [...lines].sort((a, b) => a.walkSeq - b.walkSeq).map((l) => `${l.binCode}:${l.batchCode}:${l.qty}:${l.sliceSeq}`);
      // sliceSeq follows the RANK (L1 first); walkSeq follows the bins.
      expect(byWalk).toEqual(['A-01:S-L2:5:1', 'B-01:S-L1:10:0']);
    });

    it('fractional across batches (fefo): a kg need of 2.5 over L1 1.2 + L2 5 plans 1.2 L1 + 1.3 L2', async () => {
      await seed('F-KG', 'C-01', 1.2, { code: 'KG-L1', expiryDate: expiresIn(20) });
      await seed('F-KG', 'A-01', 5, { code: 'KG-L2', expiryDate: expiresIn(100) });
      const lines = linesOf(await wave([await order([{ skuCode: 'F-KG', quantity: 2.5 }])], { release: false }));
      expect(lines.sort((a, b) => a.sliceSeq - b.sliceSeq).map((l) => `${l.batchCode}:${l.qty}`)).toEqual(['KG-L1:1.2', 'KG-L2:1.3']);
    });

    it('untracked SKUs plan in walk order under either rule; the line freezes the client\'s values', async () => {
      await seed('F-UNTRK', 'B-01', 5);
      await seed('F-UNTRK', 'A-01', 5);
      await seed('M-UNTRK', 'B-01', 5);
      await seed('M-UNTRK', 'A-01', 5);
      const [f] = linesOf(await wave([await order([{ skuCode: 'F-UNTRK', quantity: 3 }])], { release: false }));
      expect(f).toMatchObject({ binCode: 'A-01', batchId: null, allocationRule: 'fefo', minOutboundShelfLifeDays: null });
      const [m] = linesOf(await wave([await order([{ skuCode: 'M-UNTRK', quantity: 3 }])], { release: false }));
      expect(m).toMatchObject({ binCode: 'A-01', batchId: null, allocationRule: 'fefo', minOutboundShelfLifeDays: 90 });
    });

    it('minimum 90: the 60-day lot is never planned; ATP reads only the 200-day lot (10), and an undated batch is not limited', async () => {
      await seed('M-MIN', 'A-01', 10, { code: 'MN-L1', expiryDate: expiresIn(60) });
      await seed('M-MIN', 'B-01', 10, { code: 'MN-L2', expiryDate: expiresIn(200) });
      expect(await atpOf('M-MIN')).toBe(10);
      const [line] = linesOf(await wave([await order([{ skuCode: 'M-MIN', quantity: 5 }])], { release: false }));
      expect(line).toMatchObject({ batchCode: 'MN-L2', minOutboundShelfLifeDays: 90 });
      await seed('M-UNDATED', 'A-01', 4, { code: 'MU-1' });
      expect(await atpOf('M-UNDATED')).toBe(4);
      const [undated] = linesOf(await wave([await order([{ skuCode: 'M-UNDATED', quantity: 2 }])], { release: false }));
      expect(undated).toMatchObject({ batchCode: 'MU-1', qty: 2 });
    });

    it('minimum boundary: at E−90 the lot is planned and promised; at E−89 it is neither (plan and ATP agree on each date)', async () => {
      // E = today + 90: exactly 90 days left today.
      await seed('M-EDGE', 'A-01', 10, { code: 'ED-1', expiryDate: expiresIn(90) });
      const first = await order([{ skuCode: 'M-EDGE', quantity: 4 }]);
      const second = await order([{ skuCode: 'M-EDGE', quantity: 4 }]);
      batchExpiryClock.now = () => istTen(0).getTime();
      expect(await atpOf('M-EDGE')).toBe(2);
      const [planned] = linesOf(await wave([first], { at: istTen(0), release: false }));
      expect(planned).toMatchObject({ status: 'planned', batchCode: 'ED-1' });
      batchExpiryClock.now = () => istTen(1).getTime();
      // The 8 units already reserved are still held; nothing more is promised.
      expect((await inventory.atp(tenantId, wh, sku('M-EDGE'))).unpromisableBatch / 1000).toBe(10);
      expect(await atpOf('M-EDGE')).toBe(0);
      const [late] = linesOf(await wave([second], { at: istTen(1), release: false }));
      expect(late).toMatchObject({ status: 'unfulfillable', binId: null, shortfallQty: 4, allocationRule: 'fefo', minOutboundShelfLifeDays: 90 });
    });

    it('raised minimum (AC): a hold granted before the minimum rose to 90, with only 60-day stock, plans unfulfillable; promises drop at once', async () => {
      await seed('R-RAISE', 'A-01', 10, { code: 'RR-1', expiryDate: expiresIn(60) });
      const held = await order([{ skuCode: 'R-RAISE', quantity: 5 }]);
      expect(await atpOf('R-RAISE')).toBe(5);
      await putPolicy(client('RAISE'), { allocationRule: 'fefo', minOutboundShelfLifeDays: 90 }).expect(200);
      expect(await atpOf('R-RAISE')).toBe(0);
      const [line] = linesOf(await wave([held], { release: false }));
      expect(line).toMatchObject({ status: 'unfulfillable', shortfallQty: 5 });
    });

    it('frozen lines (AC): a policy edit leaves a planned wave\'s lines on fefo / null; the next wave plans fifo / 90', async () => {
      await seed('E-FROZEN', 'A-01', 10, { code: 'EF-NEW', expiryDate: expiresIn(200) });
      await seed('E-FROZEN', 'B-01', 10, { code: 'EF-OLD', expiryDate: expiresIn(300), receivedDaysAgo: 30 });
      const before = await wave([await order([{ skuCode: 'E-FROZEN', quantity: 2 }])], { release: false });
      expect(linesOf(before)[0]).toMatchObject({ batchCode: 'EF-NEW', allocationRule: 'fefo', minOutboundShelfLifeDays: null });
      await putPolicy(client('EDIT'), { allocationRule: 'fifo', minOutboundShelfLifeDays: 90 }).expect(200);
      expect(linesOf(await getWave(before.id))[0]).toMatchObject({ batchCode: 'EF-NEW', allocationRule: 'fefo', minOutboundShelfLifeDays: null });
      const after = await wave([await order([{ skuCode: 'E-FROZEN', quantity: 2 }])], { release: false });
      expect(linesOf(after)[0]).toMatchObject({ batchCode: 'EF-OLD', allocationRule: 'fifo', minOutboundShelfLifeDays: 90 });
    });

    it('one wave over two clients\' SKUs stamps each line with its own client\'s policy', async () => {
      await seed('T-TWO', 'A-01', 5, { code: 'TW-1', expiryDate: expiresIn(200) });
      await seed('M-INBIN', 'C-01', 5, { code: 'TW-M', expiryDate: expiresIn(200) });
      const w = await wave(
        [await order([{ skuCode: 'T-TWO', quantity: 1 }]), await order([{ skuCode: 'M-INBIN', quantity: 1 }])],
        { grouping: 'batch', release: false },
      );
      const bySku = new Map(linesOf(w).map((l) => [l.skuId, l]));
      expect(bySku.get(sku('T-TWO'))).toMatchObject({ allocationRule: 'fefo', minOutboundShelfLifeDays: null });
      expect(bySku.get(sku('M-INBIN'))).toMatchObject({ allocationRule: 'fefo', minOutboundShelfLifeDays: 90 });
    });

    it('4-2a × 4-3a (A23): the urgent order\'s slice takes the warehouse-wide first-ranked batch, which sits in the later bin', async () => {
      await seed('F-URGENT', 'A-01', 5, { code: 'UR-LATE', expiryDate: expiresIn(200) });
      await seed('F-URGENT', 'B-01', 5, { code: 'UR-SOON', expiryDate: expiresIn(20) });
      const normal = await order([{ skuCode: 'F-URGENT', quantity: 5 }]);
      const urgent = await order([{ skuCode: 'F-URGENT', quantity: 5 }], { priority: 'urgent' });
      const w = await wave([normal, urgent], { release: false });
      const byOrder = new Map(linesOf(w).map((l) => [l.orderId, l]));
      expect(byOrder.get(urgent)).toMatchObject({ batchCode: 'UR-SOON', binCode: 'B-01' });
      expect(byOrder.get(normal)).toMatchObject({ batchCode: 'UR-LATE', binCode: 'A-01' });
    });

    it('A7: a lost claim in the SECOND insert chunk is a 409 and rolls back every line — chunk 1 included', async () => {
      await seed('F-CHUNK1', 'A-01', 5);
      await seed('F-CHUNK2', 'B-01', 5);
      const orderId = await order([
        { skuCode: 'F-CHUNK1', quantity: 1 },
        { skuCode: 'F-CHUNK2', quantity: 1 },
      ]);
      const chunk2Line = (await sql`select id from order_lines where tenant_id = ${tenantId} and order_id = ${orderId} and sku_id = ${sku('F-CHUNK2')}`) as unknown as {
        id: string;
      }[];
      // A foreign open claim on the order line the SECOND row plans (its walk
      // position is B-01, after A-01) — an order id of its own, so the
      // eligibility read does not see it and only the unique index does.
      const blockerId = uuidv7();
      await sql`insert into picklist_lines (id, tenant_id, picklist_id, wave_id, order_id, order_line_id, sku_id, bin_id, bin_code, qty, slice_seq, walk_seq, status)
        values (${blockerId}, ${tenantId}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${chunk2Line[0]!.id}, ${sku('F-CHUNK2')}, ${bin('B-01')}, 'B-01', 1000, 0, 0, 'planned')`;
      try {
        // One row per statement: the second row is chunk 2.
        picklistLineInsertTuning.maxBindParams = 18;
        const chunks: number[] = [];
        picklistLineInsertTuning.onChunk = (rows) => chunks.push(rows);
        const res = await generate([orderId], await wavePolicy()).expect(409);
        // Chunk 1 was inserted, and chunk 2 lost the claim.
        expect(chunks).toEqual([1, 1]);
        expect(res.body.code).toBe('conflict');
        expect(await sql`select 1 from picklist_lines where tenant_id = ${tenantId} and order_id = ${orderId}`).toHaveLength(0);
      } finally {
        picklistLineInsertTuning.maxBindParams = 65_535;
        picklistLineInsertTuning.onChunk = undefined;
        await sql`delete from picklist_lines where id = ${blockerId}`;
      }
      // With the claim gone the same order waves, in two chunks, both persisted.
      picklistLineInsertTuning.maxBindParams = 18;
      const chunks: number[] = [];
      picklistLineInsertTuning.onChunk = (rows) => chunks.push(rows);
      const ok = await generate([orderId], await wavePolicy()).expect(201);
      picklistLineInsertTuning.onChunk = undefined;
      expect(chunks).toEqual([1, 1]);
      expect(ok.body.wave.picklists[0].lines).toHaveLength(2);
    });

    it('a WaveSnapshot stored before 4-3a replays unchanged — its lines without the five new keys', async () => {
      await seed('F-TASK', 'A-01', 5, { code: 'TK-1', expiryDate: expiresIn(100) });
      const orderId = await order([{ skuCode: 'F-TASK', quantity: 1 }]);
      const policyId = await wavePolicy();
      const key = ulid();
      const fresh = await generate([orderId], policyId, key).expect(201);
      expect(fresh.body.wave.picklists[0].lines[0]).toMatchObject({ batchCode: 'TK-1', allocationRule: 'fefo' });
      await sql`update idempotency_keys set response_snapshot = jsonb_set(response_snapshot, '{wave,picklists,0,lines,0}',
          (response_snapshot #> '{wave,picklists,0,lines,0}') - 'batchCode' - 'batchExpiryDate' - 'batchReceivedOn' - 'allocationRule' - 'minOutboundShelfLifeDays')
        where tenant_id = ${tenantId} and key = ${key}`;
      const replay = await generate([orderId], policyId, key).expect(201);
      const line = replay.body.wave.picklists[0].lines[0] as Record<string, unknown>;
      for (const k of ['batchCode', 'batchExpiryDate', 'batchReceivedOn', 'allocationRule', 'minOutboundShelfLifeDays']) {
        expect(line).not.toHaveProperty(k);
      }
      // Release it so the handheld test below sees a task.
      await http()
        .post(`${API}/${tenantId}/outbound/waves/${fresh.body.wave.id as string}/release`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({})
        .expect(200);
    });

    it('the handheld task carries the batch expiry, the lot\'s first receipt and the frozen policy', async () => {
      const res = await http()
        .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${wh}`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);
      const task = (res.body.pickTasks as Record<string, unknown>[]).find((t) => t.skuId === sku('F-TASK'));
      expect(task).toMatchObject({
        batchCode: 'TK-1',
        batchExpiryDate: addIsoDays(today, 100),
        batchReceivedOn: today,
        allocationRule: 'fefo',
        minOutboundShelfLifeDays: null,
      });
    });
  });

  // ── the pick draw ─────────────────────────────────────────────────────────

  describe('the pick draw', () => {
    it('pick in bin: a fefo / 90 line in a bin holding a 60-day and a 200-day lot draws the 200-day lot', async () => {
      await seed('M-INBIN', 'A-01', 5, { code: 'IB-L2', expiryDate: expiresIn(200) });
      const [line] = linesOf(await wave([await order([{ skuCode: 'M-INBIN', quantity: 3 }])]));
      expect(line).toMatchObject({ binCode: 'A-01', batchCode: 'IB-L2' });
      await seed('M-INBIN', 'A-01', 5, { code: 'IB-L1', expiryDate: expiresIn(60) });
      await pick(line!).expect(201);
      expect(await drawnBatchCodes(line!.id)).toEqual([{ code: 'IB-L2', qty: 3 }]);
    });

    it('refusal text: a bin holding only stock below the line\'s minimum refuses 422 (epoch unmoved) / 409 (moved), naming the units, the client and the minimum; nothing is recorded', async () => {
      await seed('M-ONLY', 'A-01', 3, { code: 'ON-L2', expiryDate: expiresIn(200) });
      const [line] = linesOf(await wave([await order([{ skuCode: 'M-ONLY', quantity: 3 }])]));
      // The planned lot leaves the bin (another draw), and only a 60-day lot remains.
      await http()
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: wh, skuId: sku('M-ONLY'), binId: bin('A-01'), quantityDelta: -3, reasonCode: 'stock-count', note: 'drain' })
        .expect(201);
      await seed('M-ONLY', 'A-01', 10, { code: 'ON-L1', expiryDate: expiresIn(60) });
      const unmoved = await pick(line!).expect(422);
      expect(unmoved.body.code).toBe('insufficient-on-hand');
      expect(unmoved.body.detail).toContain("holds 0 drawable unit(s) of this SKU — 10 more are below client MIN's minimum remaining shelf life of 90 days; the pick draws 3");
      const moved = await pick(line!, { binStateEpoch: 999_999 }).expect(409);
      expect(moved.body.code).toBe('pick-bin-short');
      expect(moved.body.detail).toContain('10 more are below client');
      expect(await drawnBatchCodes(line!.id)).toEqual([]);
      expect(await sql`select 1 from picks where tenant_id = ${tenantId} and picklist_line_id = ${line!.id}`).toHaveLength(0);
    });

    it('grace (AC): planned with exactly the minimum left and picked the NEXT day, the pick draws it (judged on the plan date)', async () => {
      // Planned yesterday with exactly 90 days left (E = yesterday + 90).
      await seed('M-GRACE', 'A-01', 5, { code: 'GR-1', expiryDate: expiresIn(89) });
      batchExpiryClock.now = () => istTen(-1).getTime();
      const orderId = await order([{ skuCode: 'M-GRACE', quantity: 2 }]);
      const [line] = linesOf(await wave([orderId], { at: istTen(-1) }));
      expect(line).toMatchObject({ batchCode: 'GR-1' });
      await sql`update picklists set created_at = ${istTen(-1).toISOString()} where id = ${line!.picklistId}`;
      batchExpiryClock.now = () => Date.now();
      // Picked today: max(plan, today − 1) = yesterday → 90 days → allocatable.
      await pick(line!).expect(201);
      expect(await drawnBatchCodes(line!.id)).toEqual([{ code: 'GR-1', qty: 2 }]);
    });

    it('grace capped (AC): planned three days ago with exactly the minimum left, the pick refuses — judged yesterday, 88 days', async () => {
      await seed('M-CAP', 'A-01', 5, { code: 'CP-1', expiryDate: expiresIn(87) });
      batchExpiryClock.now = () => istTen(-3).getTime();
      const orderId = await order([{ skuCode: 'M-CAP', quantity: 2 }]);
      const [line] = linesOf(await wave([orderId], { at: istTen(-3) }));
      expect(line).toMatchObject({ batchCode: 'CP-1' });
      await sql`update picklists set created_at = ${istTen(-3).toISOString()} where id = ${line!.picklistId}`;
      batchExpiryClock.now = () => Date.now();
      const refused = await pick(line!).expect(422);
      expect(refused.body.detail).toContain("5 more are below client MIN's minimum remaining shelf life of 90 days");
    });

    it('expiry is still judged at the op: a lot that expired at 00:00 today is not drawn, grace or not', async () => {
      await seed('M-EXP', 'A-01', 5, { code: 'EX-1', expiryDate: expiresIn(0) });
      batchExpiryClock.now = () => istTen(-1).getTime();
      // No minimum here: this row is about expiry alone.
      await sql`update clients set min_outbound_shelf_life_days = null where id = ${client('MIN')}`;
      try {
        const orderId = await order([{ skuCode: 'M-EXP', quantity: 1 }]);
        const [line] = linesOf(await wave([orderId], { at: istTen(-1) }));
        expect(line).toMatchObject({ batchCode: 'EX-1' });
        await sql`update picklists set created_at = ${istTen(-1).toISOString()} where id = ${line!.picklistId}`;
        batchExpiryClock.now = () => Date.now();
        const refused = await pick(line!).expect(422);
        // Expired, not below a minimum: no suffix.
        expect(refused.body.detail).not.toContain('below client');
      } finally {
        await sql`update clients set min_outbound_shelf_life_days = 90 where id = ${client('MIN')}`;
      }
    });

    it('legacy line (both null): the pick draws today\'s in-bin FEFO with no minimum', async () => {
      await seed('F-LEGACY', 'A-01', 5, { code: 'LG-LATE', expiryDate: expiresIn(200) });
      const [line] = linesOf(await wave([await order([{ skuCode: 'F-LEGACY', quantity: 2 }])]));
      await sql`update picklist_lines set allocation_rule = null, min_outbound_shelf_life_days = null, batch_id = null where id = ${line!.id}`;
      await seed('F-LEGACY', 'A-01', 5, { code: 'LG-SOON', expiryDate: expiresIn(10) });
      await pick({ ...line!, batchId: null }).expect(201);
      expect(await drawnBatchCodes(line!.id)).toEqual([{ code: 'LG-SOON', qty: 2 }]);
    });
  });

  // ── the short-pick re-plan ────────────────────────────────────────────────

  describe('the re-plan', () => {
    it('A1: a re-plan across B-01 (earlier expiry) and A-01 stamps fefo and walks A-01 before B-01', async () => {
      await seed('F-REPLAN', 'C-01', 4, { code: 'RP-L0', expiryDate: expiresIn(10) });
      await seed('F-REPLAN', 'B-01', 3, { code: 'RP-L1', expiryDate: expiresIn(30) });
      await seed('F-REPLAN', 'A-01', 10, { code: 'RP-L2', expiryDate: expiresIn(200) });
      const [line] = linesOf(await wave([await order([{ skuCode: 'F-REPLAN', quantity: 4 }])]));
      expect(line).toMatchObject({ binCode: 'C-01', batchCode: 'RP-L0' });
      const res = await pick(line!, { qty: 0, reasonCode: 'bin-empty' }).expect(201);
      const replanned = res.body.pick.replanned as { binCode: string; batchId: string; qty: number; walkSeq: number; sliceSeq: number }[];
      const byWalk = [...replanned].sort((a, b) => a.walkSeq - b.walkSeq);
      expect(byWalk.map((s) => `${s.binCode}:${s.qty}`)).toEqual(['A-01:1', 'B-01:3']);
      const stamped = (await sql`select allocation_rule, min_outbound_shelf_life_days from picklist_lines
        where id = any(${replanned.map((s) => (s as unknown as { picklistLineId: string }).picklistLineId)}::uuid[])`) as unknown as {
        allocation_rule: string;
        min_outbound_shelf_life_days: number | null;
      }[];
      expect(stamped).toEqual([
        { allocation_rule: 'fefo', min_outbound_shelf_life_days: null },
        { allocation_rule: 'fefo', min_outbound_shelf_life_days: null },
      ]);
    });

    it('A3 on the re-plan: planned yesterday, short-picked today, a lot with exactly 90 days left on the plan date (89 today) is re-planned', async () => {
      await seed('M-RGRACE', 'C-01', 3, { code: 'RG-PLAN', expiryDate: expiresIn(300) });
      batchExpiryClock.now = () => istTen(-1).getTime();
      const orderId = await order([{ skuCode: 'M-RGRACE', quantity: 3 }]);
      const [line] = linesOf(await wave([orderId], { at: istTen(-1) }));
      expect(line).toMatchObject({ binCode: 'C-01', batchCode: 'RG-PLAN' });
      // After the plan, A-01 receives a lot with exactly 90 days left on the plan date.
      await seed('M-RGRACE', 'A-01', 3, { code: 'RG-EDGE', expiryDate: expiresIn(89) });
      await sql`update picklists set created_at = ${istTen(-1).toISOString()} where id = ${line!.picklistId}`;
      batchExpiryClock.now = () => Date.now();
      const res = await pick(line!, { qty: 0, reasonCode: 'bin-empty' }).expect(201);
      const replanned = res.body.pick.replanned as { binCode: string; batchId: string; qty: number }[];
      expect(replanned.map((s) => `${s.binCode}:${s.qty}`)).toEqual(['A-01:3']);
    });

    it('a short pick on a frozen fifo / 90 line re-plans fifo, excludes short-life stock, and copies the columns', async () => {
      await seed('Q-REPLAN', 'C-01', 4, { code: 'QR-PLAN', expiryDate: expiresIn(300), receivedDaysAgo: 200 });
      const [line] = linesOf(await wave([await order([{ skuCode: 'Q-REPLAN', quantity: 4 }])]));
      expect(line).toMatchObject({ binCode: 'C-01', allocationRule: 'fifo', minOutboundShelfLifeDays: 90 });
      await seed('Q-REPLAN', 'A-01', 10, { code: 'QR-YOUNG', expiryDate: expiresIn(300) });
      await seed('Q-REPLAN', 'B-01', 2, { code: 'QR-OLD', expiryDate: expiresIn(300), receivedDaysAgo: 60 });
      await seed('Q-REPLAN', 'B-01', 10, { code: 'QR-SHORT', expiryDate: expiresIn(30), receivedDaysAgo: 100 });
      const res = await pick(line!, { qty: 0, reasonCode: 'bin-empty' }).expect(201);
      const replanned = res.body.pick.replanned as { picklistLineId: string; batchId: string; qty: number }[];
      const codes = await Promise.all(
        replanned.map(async (s) => `${((await sql`select code from batches where id = ${s.batchId}`)[0] as unknown as { code: string }).code}:${s.qty}`),
      );
      expect(codes.sort()).toEqual(['QR-OLD:2', 'QR-YOUNG:2']);
      const stamped = (await sql`select distinct allocation_rule, min_outbound_shelf_life_days from picklist_lines
        where id = any(${replanned.map((s) => s.picklistLineId)}::uuid[])`) as unknown as object[];
      expect(stamped).toEqual([{ allocation_rule: 'fifo', min_outbound_shelf_life_days: 90 }]);
    });

    it('A4: a legacy line\'s re-plan stamps the client\'s CURRENT policy (fifo / 90) and ranks so', async () => {
      await seed('Q-LEGACY', 'C-01', 3, { code: 'QL-PLAN', expiryDate: expiresIn(300) });
      const [line] = linesOf(await wave([await order([{ skuCode: 'Q-LEGACY', quantity: 3 }])]));
      await sql`update picklist_lines set allocation_rule = null, min_outbound_shelf_life_days = null where id = ${line!.id}`;
      await seed('Q-LEGACY', 'A-01', 5, { code: 'QL-SHORT', expiryDate: expiresIn(30), receivedDaysAgo: 90 });
      await seed('Q-LEGACY', 'B-01', 5, { code: 'QL-OK', expiryDate: expiresIn(300), receivedDaysAgo: 10 });
      const res = await pick(line!, { qty: 0, reasonCode: 'bin-empty' }).expect(201);
      const replanned = res.body.pick.replanned as { picklistLineId: string; binCode: string; qty: number }[];
      expect(replanned.map((s) => `${s.binCode}:${s.qty}`)).toEqual(['B-01:3']);
      const stamped = (await sql`select allocation_rule, min_outbound_shelf_life_days from picklist_lines where id = ${replanned[0]!.picklistLineId}`) as unknown as object[];
      expect(stamped).toEqual([{ allocation_rule: 'fifo', min_outbound_shelf_life_days: 90 }]);
    });
  });

  // ── ATP refusal text ──────────────────────────────────────────────────────

  it('A15: a buffer refused over below-minimum stock names it as "blocked or expired batches, or below the client\'s minimum remaining shelf life"', async () => {
    await seed('M-BUF', 'A-01', 10, { code: 'BF-1', expiryDate: expiresIn(60) });
    expect(await atpOf('M-BUF')).toBe(0);
    const refusal = await inventory
      .applyChannelBuffer({ tenantId, warehouseId: wh, skuId: sku('M-BUF'), ownerId: uuidv7(), targetMilli: 3_000 })
      .then(
        () => null,
        (err: unknown) => err as { getResponse(): { code: string; detail: string } },
      );
    expect(refusal?.getResponse().detail).toContain(
      "(of which 10 in blocked or expired batches, or below the client's minimum remaining shelf life)",
    );
  });
});
