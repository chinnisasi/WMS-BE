import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import Redis from 'ioredis';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { ensureReceivingBinInTx } from '../src/modules/tenancy/receiving-bin';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';
import { MOVE_REASON_CODES } from '../src/modules/movements/move-reason';
import { ProblemException } from '../src/shared/problem-details/problem.exception';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow } from './support/audit-guard';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
// A host that exports any poll interval would boot background workers and
// race these tests — the sibling suites' convention.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';

const PLAIN = 'MV-PLAIN';
const PLAIN2 = 'MV-PLAIN2';
const BATCH = 'MV-BATCH';
const BSERIAL = 'MV-BSERIAL';
const CATCH_WEIGHT = 'MV-CW';
const COMPONENT = 'MV-COMP';
const KIT = 'MV-KIT';
const OXIDIZER = 'MV-OXI';
const FLAMMABLE = 'MV-FLAM';
const PICKED = 'MV-PICK';
const SECURE_SKU = 'MV-SEC';
const SERIAL_ONLY = 'MV-SER';
const SKU_CODES = [PLAIN, PLAIN2, BATCH, BSERIAL, CATCH_WEIGHT, COMPONENT, KIT, OXIDIZER, FLAMMABLE, PICKED, SECURE_SKU, SERIAL_ONLY] as const;

/**
 * Story 3-1 — the bin-to-bin move (`POST …/warehouses/{w}/inventory/moves`):
 * every row of the spec's I/O matrix, the same-key lock race, opposite
 * concurrent moves, a device pick holding the pre-move epoch, device replay
 * and review Apply/Discard, a hash golden per surface, and reconcile.
 */
describe('bin-to-bin moves (e2e, story 3-1)', () => {
  let app: INestApplication;
  let inventory: InventoryFacade;
  let sql: postgres.Sql;
  let valkey: Redis;
  let suiteDb: SuiteDatabase;

  let tenantId = '';
  let ownerToken = '';
  let ownerUserId = '';
  let opsToken = '';
  let opsUserId = '';
  let operatorToken = '';
  let operatorUserId = '';
  let accountantToken = '';
  let deviceToken = ''; // the operator's badge-in session
  let bareDeviceToken = ''; // the same device's enrollment credential (no badge-in)
  let deviceId = '';
  let warehouseId = '';
  let otherWarehouseId = '';
  const skuIds = new Map<string, string>();
  const binIds = new Map<string, string>();
  let receivingBinId = '';
  let glowClientId = '';

  const http = () => request(app.getHttpServer());
  const sku = (code: string): string => skuIds.get(code)!;
  const bin = (code: string): string => binIds.get(code)!;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('moves');
    app = await createApp(false);
    await app.init();
    inventory = app.get(InventoryFacade);
    sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });

    const ownerEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Move Co ${ulid()}`, ownerEmail, password: PASSWORD })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email: ownerEmail, password: PASSWORD })).body.accessToken as string;
    ownerUserId = (await sql<{ id: string }[]>`select id from users where tenant_id = ${tenantId} and role = 'owner' limit 1`)[0]!.id;

    const mkWarehouse = async (code: string): Promise<string> =>
      (
        await http()
          .post(`${API}/${tenantId}/warehouses`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ origin: testAddress(), code, name: `Move WH ${code}` })
          .expect(201)
      ).body.id as string;
    warehouseId = await mkWarehouse(`MV-${ulid().slice(10, 16)}`);
    otherWarehouseId = await mkWarehouse(`MO-${ulid().slice(10, 16)}`);

    const csv = [
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,catch_weight_tracked,reorder_point,reorder_qty,barcode',
      `${PLAIN},Move Plain,pcs,,1800,,false,false,false,,,`,
      `${PLAIN2},Move Plain Two,pcs,,1800,,false,false,false,,,`,
      `${BATCH},Move Batch,pcs,,1800,,true,false,false,,,`,
      `${BSERIAL},Move Batch Serial,pcs,,1800,,true,true,false,,,`,
      `${CATCH_WEIGHT},Move CatchWeight,kg,,1800,,false,false,true,,,`,
      `${COMPONENT},Move Component,pcs,,1800,,false,false,false,,,`,
      `${KIT},Move Kit,pcs,,1800,,false,false,false,,,`,
      `${OXIDIZER},Move Oxidizer,pcs,,1800,,false,false,false,,,`,
      `${FLAMMABLE},Move Flammable,pcs,,1800,,false,false,false,,,`,
      `${PICKED},Move Picked,pcs,,1800,,false,false,false,,,`,
      `${SECURE_SKU},Move Secure,pcs,,1800,,false,false,false,,,`,
      `${SERIAL_ONLY},Move Serial Only,pcs,,1800,,false,true,false,,,`,
    ].join('\n');
    await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const skus = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    for (const item of skus.body.items as { code: string; id: string }[]) {
      if ((SKU_CODES as readonly string[]).includes(item.code)) skuIds.set(item.code, item.id);
    }
    expect(skuIds.size).toBe(SKU_CODES.length);
    glowClientId = (
      await http()
        .post(`${API}/${tenantId}/clients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'GLOW', name: 'GlowCo' })
        .expect(201)
    ).body.client.id as string;

    const zones = new Map<string, string>();
    const mkBin = async (whId: string, code: string, extra: Record<string, unknown> = {}): Promise<string> => {
      const zoneCode = code.slice(0, 1);
      let zoneId = zones.get(`${whId}|${zoneCode}`);
      if (zoneId === undefined) {
        zoneId = (
          await http()
            .post(`${API}/${tenantId}/warehouses/${whId}/zones`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .set(KEY_HEADER, ulid())
            .send({ code: zoneCode, name: `Zone ${zoneCode}` })
            .expect(201)
        ).body.id as string;
        zones.set(`${whId}|${zoneCode}`, zoneId);
      }
      const id = (
        await http()
          .post(`${API}/${tenantId}/warehouses/${whId}/zones/${zoneId}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ capacity: 1000, type: 'shelf', code, ...extra })
          .expect(201)
      ).body.id as string;
      binIds.set(code, id);
      return id;
    };
    for (const code of ['A-01', 'B-01', 'C-01', 'D-01', 'E-01', 'F-01', 'G-01', 'H-01', 'J-01', 'K-01', 'L-01', 'R-01', 'X-01', 'Y-01', 'W-01', 'Q-01']) {
      await mkBin(warehouseId, code);
    }
    await mkBin(warehouseId, 'M-SMALL', { capacity: 5 });
    await mkBin(warehouseId, 'N-HAZ', { storageClass: 'hazardous' });
    await mkBin(warehouseId, 'P-GLOW', { dedicatedClientId: glowClientId });
    await mkBin(warehouseId, 'S-SEC', { storageClass: 'secure' });
    await mkBin(warehouseId, 'T-BLOCK');
    await mkBin(warehouseId, 'U-RETIRE');
    await mkBin(warehouseId, 'V-BLOCKORIGIN');
    await mkBin(otherWarehouseId, 'Z-01');

    await http()
      .post(`${API}/${tenantId}/catalog/skus/${sku(KIT)}/kit`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ components: [{ skuId: sku(COMPONENT), quantity: 1 }] })
      .expect(201);
    // A secure-class SKU — patched before any stock exists (the class-edit guard).
    await http()
      .patch(`${API}/${tenantId}/catalog/skus/${sku(SECURE_SKU)}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ storageClass: 'secure' })
      .expect(200);
    for (const [code, hazardClass] of [
      [OXIDIZER, 'oxidizer'],
      [FLAMMABLE, 'flammable'],
    ] as const) {
      await http()
        .patch(`${API}/${tenantId}/catalog/skus/${sku(code)}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ hazardClass })
        .expect(200);
    }

    const mkMember = async (role: 'ops_manager' | 'operator' | 'accountant'): Promise<{ userId: string; email: string; token: string }> => {
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
      const token = (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
      return { userId: invited.body.user.id as string, email, token };
    };
    const ops = await mkMember('ops_manager');
    opsToken = ops.token;
    opsUserId = ops.userId;
    const operator = await mkMember('operator');
    operatorToken = operator.token;
    operatorUserId = operator.userId;
    accountantToken = (await mkMember('accountant')).token;

    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'move-suite device', pin: '2468' })
      .expect(201);
    deviceId = enrolled.body.device.id as string;
    bareDeviceToken = enrolled.body.deviceToken as string;
    deviceToken = (
      await http()
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail: operator.email, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;

    // The system Receiving bin (lazily ensured — the move refuses it).
    receivingBinId = (
      await withTenantTransaction(app.get(DATABASE) as Parameters<typeof withTenantTransaction>[0], tenantId, (tx) =>
        ensureReceivingBinInTx(tx, tenantId, warehouseId),
      )
    ).binId;

    // Stock — the named stock.adjust seeds.
    await seed(PLAIN, 'A-01', 30);
    await seed(PLAIN2, 'B-01', 10);
    await seed(PLAIN, 'C-01', 4);
    await seed(BATCH, 'D-01', 5, { batch: { code: 'L1' } });
    await seed(BATCH, 'D-01', 3, { batch: { code: 'L2' } });
    await seed(BSERIAL, 'E-01', 2, { batch: { code: 'SB1' }, serials: ['S1', 'S2'] });
    await seed(BSERIAL, 'F-01', 1, { batch: { code: 'SB2' }, serials: ['S3'] });
    await seed(OXIDIZER, 'G-01', 2);
    await seed(FLAMMABLE, 'H-01', 2);
    await seed(PLAIN, 'S-SEC', 6, {}, ownerToken);
    await seed(PLAIN, 'V-BLOCKORIGIN', 3);
    await seed(PLAIN, 'J-01', 8);
    // The adjustment bypasses the class gate: a secure SKU in an ordinary bin.
    await seed(SECURE_SKU, 'W-01', 4, {}, ownerToken);
    await seed(SERIAL_ONLY, 'Q-01', 2, { serials: ['T1', 'T2'] });

    await http()
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${bin('T-BLOCK')}/block`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ reason: 'damaged' })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${bin('V-BLOCKORIGIN')}/block`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ reason: 'damaged' })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${bin('U-RETIRE')}/retire`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    await inventory.rebuildReservationCounters(tenantId, warehouseId);
  }, 180_000);

  afterAll(async () => {
    const keys = tenantId === '' ? [] : await valkey.keys(`wms:{${tenantId}}:*`).catch(() => [] as string[]);
    if (keys.length > 0) await valkey.del(...keys);
    await valkey.quit().catch(() => valkey.disconnect());
    const rawDb = app?.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } } | undefined;
    await rawDb?.$client?.end();
    const authDb = app?.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } } | undefined;
    await authDb?.$client?.end();
    await sql?.end();
    await app?.close();
    await suiteDb?.drop();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function seed(code: string, binCode: string, quantity: number, extra: Record<string, unknown> = {}, token = opsToken): Promise<void> {
    await http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId: sku(code), binId: bin(binCode), quantityDelta: quantity, reasonCode: 'stock-count', note: 'move-suite seed', ...extra })
      .expect(201);
  }

  interface MoveBody {
    skuId: string;
    fromBinId: string;
    toBinId: string;
    qty: number;
    batchCode?: string | null;
    serials?: string[] | null;
    reasonCode?: string;
    note?: string | null;
    occurredAt?: string;
  }

  function body(code: string, from: string, to: string, qty: number, extra: Partial<MoveBody> = {}): MoveBody {
    return { skuId: sku(code), fromBinId: bin(from), toBinId: bin(to), qty, reasonCode: 'consolidate', ...extra };
  }

  function move(payload: MoveBody | Record<string, unknown>, token = opsToken, key = ulid(), whId = warehouseId): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/warehouses/${whId}/inventory/moves`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(payload);
  }

  async function onHand(code: string, binCode: string): Promise<number> {
    const rows = await sql<{ quantity: string }[]>`
      select quantity::text from stock_on_hand where tenant_id = ${tenantId} and sku_id = ${sku(code)} and bin_id = ${bin(binCode)}`;
    return rows.length === 0 ? 0 : Number(rows[0]!.quantity) / 1000;
  }

  async function movedEvents(moveId: string): Promise<{ batch_ref: string | null; serial_ref: string | null; quantity_delta: string; from_bin_id: string; to_bin_id: string; reference_doc: Record<string, unknown> }[]> {
    return sql`
      select batch_ref, serial_ref, quantity_delta::text, from_bin_id, to_bin_id, reference_doc
      from ledger_events where tenant_id = ${tenantId} and type = 'stock.moved' and reference_doc->>'moveId' = ${moveId}
      order by seq`;
  }

  async function count(table: string, where: string, params: unknown[] = []): Promise<number> {
    const rows = await sql.unsafe(`select count(*)::int as n from ${table} where tenant_id = $1 ${where}`, [tenantId, ...params] as never[]);
    return (rows[0] as unknown as { n: number }).n;
  }

  async function batchIdOf(code: string): Promise<string> {
    return (await sql<{ id: string }[]>`select id from batches where tenant_id = ${tenantId} and code = ${code}`)[0]!.id;
  }

  // ── the matrix ─────────────────────────────────────────────────────────────

  it('plain move: 30 in A, move 20 A→B → one stock.moved event, A 10 and B 20, one audit row; a replay re-serves it', async () => {
    const key = ulid();
    const payload = body(PLAIN, 'A-01', 'K-01', 20);
    const res = await move(payload, opsToken, key).expect(201);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({ skuId: sku(PLAIN), quantity: 20, fromBinId: bin('A-01'), toBinId: bin('K-01'), batchRef: null, serialRef: null });
    expect(await onHand(PLAIN, 'A-01')).toBe(10);
    expect(await onHand(PLAIN, 'K-01')).toBe(20);
    const events = await movedEvents(res.body.moveId as string);
    expect(events).toHaveLength(1);
    expect(events[0]!.quantity_delta).toBe('20000');
    expect(events[0]!.reference_doc).toEqual({ kind: 'bin-move', moveId: res.body.moveId, reasonCode: 'consolidate' });
    await expectAuditRow({ tenantId, key, action: 'stock.moved', targetType: 'bin_move', targetId: res.body.moveId as string, actorUserId: opsUserId });

    const replay = await move(payload, opsToken, key).expect(201);
    expect(replay.body).toEqual(res.body);
    expect(await movedEvents(res.body.moveId as string)).toHaveLength(1);
    expect(await onHand(PLAIN, 'A-01')).toBe(10);
    await expectAuditRow({ tenantId, key, action: 'stock.moved', targetType: 'bin_move', targetId: res.body.moveId as string, actorUserId: opsUserId });
    // No outbox event — ATP is unchanged.
    expect(await count('outbox_messages', "and type like 'stock.mov%'")).toBe(0);
  });

  it('batch: 5 of L1 moves on one event carrying the batch; an unknown batch is 404, a batch on an untracked SKU is 400, a missing batch is 400', async () => {
    const res = await move(body(BATCH, 'D-01', 'L-01', 2, { batchCode: 'L1' })).expect(201);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].batchRef).toBe(await batchIdOf('L1'));
    const boh = await sql<{ quantity: string }[]>`
      select quantity::text from batch_on_hand where tenant_id = ${tenantId} and bin_id = ${bin('L-01')} and batch_id = ${await batchIdOf('L1')}`;
    expect(Number(boh[0]!.quantity)).toBe(2000);

    const unknown = await move(body(BATCH, 'D-01', 'L-01', 1, { batchCode: 'L9' })).expect(404);
    expect(unknown.body.code).toBe('not-found');
    expect(unknown.body.detail).toContain('L9');
    const untracked = await move(body(PLAIN, 'A-01', 'L-01', 1, { batchCode: 'L1' })).expect(400);
    expect(untracked.body.code).toBe('validation-failed');
    expect(untracked.body.detail).toMatch(/not batch-tracked/);
    const missing = await move(body(BATCH, 'D-01', 'L-01', 1)).expect(400);
    expect(missing.body.detail).toMatch(/batch-tracked/);
    // The batch arm's short: D-01 holds 6 (L1 3, L2 3) — the plain arm covers 4, L2 does not.
    const short = await move(body(BATCH, 'D-01', 'L-01', 4, { batchCode: 'L2' })).expect(409);
    expect(short.body.code).toBe('move-source-short');
    expect(short.body.detail).toContain('L2');
  });

  it('serials: S1, S2 of a batch+serial SKU move as two magnitude-1 events, each with its own batch; shape, elsewhere and unknown refusals', async () => {
    const res = await move(body(BSERIAL, 'E-01', 'X-01', 2, { serials: ['S2', 'S1'] })).expect(201);
    expect(res.body.events).toHaveLength(2);
    const sb1 = await batchIdOf('SB1');
    for (const event of res.body.events as { quantity: number; batchRef: string; serialRef: string }[]) {
      expect(event.quantity).toBe(1);
      expect(event.batchRef).toBe(sb1);
      expect(event.serialRef).not.toBeNull();
    }
    expect(await onHand(BSERIAL, 'X-01')).toBe(2);
    expect(await onHand(BSERIAL, 'E-01')).toBe(0);

    const countMismatch = await move(body(BSERIAL, 'X-01', 'E-01', 1, { serials: ['S1', 'S2'] })).expect(400);
    expect(countMismatch.body.detail).toMatch(/qty must equal the number of serials/);
    const duplicate = await move(body(BSERIAL, 'X-01', 'E-01', 2, { serials: ['S1', 'S1'] })).expect(400);
    expect(duplicate.body.detail).toMatch(/same serial twice/);
    const besideBatch = await move(body(BSERIAL, 'X-01', 'E-01', 1, { serials: ['S1'], batchCode: 'SB1' })).expect(400);
    expect(besideBatch.body.detail).toMatch(/no batchCode/);
    const noSerials = await move(body(BSERIAL, 'X-01', 'E-01', 1)).expect(400);
    expect(noSerials.body.detail).toMatch(/serial-tracked/);
    const elsewhere = await move(body(BSERIAL, 'X-01', 'E-01', 2, { serials: ['S1', 'S3'] })).expect(409);
    expect(elsewhere.body.code).toBe('serial-elsewhere');
    // All or nothing: S1 did not move.
    expect(await onHand(BSERIAL, 'X-01')).toBe(2);
    const unknown = await move(body(BSERIAL, 'X-01', 'E-01', 1, { serials: ['S404'] })).expect(404);
    expect(unknown.body.code).toBe('serial-unknown');
    const tooMany = await move(body(BSERIAL, 'X-01', 'E-01', 501, { serials: Array.from({ length: 501 }, (_, i) => `Q${i}`) })).expect(400);
    expect(tooMany.body.code).toBe('validation-failed');
  });

  it('short: 4 in C, move 5 → 409 move-source-short, nothing written', async () => {
    const res = await move(body(PLAIN, 'C-01', 'L-01', 5)).expect(409);
    expect(res.body.code).toBe('move-source-short');
    expect(res.body.detail).toContain('C-01');
    expect(await onHand(PLAIN, 'C-01')).toBe(4);
  });

  it('same, system or retired: A = A → 400; a system origin or target → 409 bin-not-movable; a retired origin → 409 bin-retired', async () => {
    const same = await move(body(PLAIN, 'A-01', 'A-01', 1)).expect(400);
    expect(same.body.detail).toMatch(/same bin/);
    const systemTarget = await move({ ...body(PLAIN, 'A-01', 'L-01', 1), toBinId: receivingBinId }).expect(409);
    expect(systemTarget.body.code).toBe('bin-not-movable');
    const systemOrigin = await move({ ...body(PLAIN, 'A-01', 'L-01', 1), fromBinId: receivingBinId }).expect(409);
    expect(systemOrigin.body.code).toBe('bin-not-movable');
    const retiredOrigin = await move(body(PLAIN, 'U-RETIRE', 'L-01', 1)).expect(409);
    expect(retiredOrigin.body.code).toBe('bin-retired');
    expect(retiredOrigin.body.detail).toMatch(/Origin|retired/);
    // A bin of another warehouse is not in this warehouse: 404.
    const foreign = await move({ ...body(PLAIN, 'A-01', 'L-01', 1), toBinId: bin('Z-01') }).expect(404);
    expect(foreign.body.code).toBe('not-found');
  });

  it("target gates: retired, blocked, wrong class, other client, segregation, over capacity — each the gate's own code", async () => {
    const cases: [string, string, string, number, string][] = [
      ['retired', PLAIN, 'U-RETIRE', 1, 'bin-retired'],
      ['blocked', PLAIN, 'T-BLOCK', 1, 'bin-blocked'],
      ['class', PLAIN, 'N-HAZ', 1, 'bin-storage-mismatch'],
      ['client', PLAIN, 'P-GLOW', 1, 'bin-client-mismatch'],
      ['capacity', PLAIN, 'M-SMALL', 6, 'bin-full'],
    ];
    for (const [, code, target, qty, expected] of cases) {
      const res = await move(body(code, 'A-01', target, qty)).expect(409);
      expect(res.body.code).toBe(expected);
    }
    const blocked = await move(body(PLAIN, 'A-01', 'T-BLOCK', 1)).expect(409);
    expect(blocked.body.detail).toMatch(/move intake/);
    // Segregation: flammable into the oxidizer's bin.
    const segregated = await move(body(FLAMMABLE, 'H-01', 'G-01', 1)).expect(409);
    expect(segregated.body.code).toBe('bin-segregation-conflict');
    expect(await onHand(FLAMMABLE, 'H-01')).toBe(2);
  });

  it('secure: an operator moving out of a secure bin → 403 role-denied naming secure.move; the ops manager may', async () => {
    const denied = await move(body(PLAIN, 'S-SEC', 'L-01', 1), operatorToken).expect(403);
    expect(denied.body.code).toBe('role-denied');
    expect(denied.body.detail).toContain('secure.move');
    await move(body(PLAIN, 'S-SEC', 'L-01', 1), opsToken).expect(201);
  });

  it('quarantine, kit, catch-weight: either scope quarantined → 409; a kit → 409; catch-weight → 400', async () => {
    const quarantineId = uuidv7();
    await sql`
      insert into inventory_quarantines (id, tenant_id, warehouse_id, sku_id, bin_id, from_seq, to_seq, reason, status)
      values (${quarantineId}, ${tenantId}, ${warehouseId}, ${sku(PLAIN)}, ${bin('J-01')}, 1, 1, 'move-suite', 'open')`;
    const outOf = await move(body(PLAIN, 'J-01', 'L-01', 1)).expect(409);
    expect(outOf.body.code).toBe('move-scope-quarantined');
    const into = await move(body(PLAIN, 'A-01', 'J-01', 1)).expect(409);
    expect(into.body.code).toBe('move-scope-quarantined');
    await sql`update inventory_quarantines set status = 'resolved' where id = ${quarantineId}`;
    await move(body(PLAIN, 'J-01', 'L-01', 1)).expect(201);

    const kit = await move(body(KIT, 'A-01', 'L-01', 1)).expect(409);
    expect(kit.body.code).toBe('kit-cannot-hold-stock');
    const cw = await move(body(CATCH_WEIGHT, 'A-01', 'L-01', 1)).expect(400);
    expect(cw.body.detail).toMatch(/catch-weight/);
  });

  it('a blocked origin moves out', async () => {
    await move(body(PLAIN, 'V-BLOCKORIGIN', 'L-01', 3)).expect(201);
    expect(await onHand(PLAIN, 'V-BLOCKORIGIN')).toBe(0);
  });

  it('reason: none → 400; `other` without a note → 400; with a note the note rides the reference doc trimmed; a note over 200 → 400', async () => {
    const { reasonCode: _drop, ...noReason } = body(PLAIN, 'A-01', 'L-01', 1);
    void _drop;
    await move(noReason).expect(400);
    const bad = await move(body(PLAIN, 'A-01', 'L-01', 1, { reasonCode: 'tidy' })).expect(400);
    expect(bad.body.code).toBe('validation-failed');
    const noNote = await move(body(PLAIN, 'A-01', 'L-01', 1, { reasonCode: 'other' })).expect(400);
    expect(noNote.body.detail).toMatch(/note/);
    const blank = await move(body(PLAIN, 'A-01', 'L-01', 1, { reasonCode: 'other', note: '   ' })).expect(400);
    expect(blank.body.detail).toMatch(/note/);
    const long = await move(body(PLAIN, 'A-01', 'L-01', 1, { reasonCode: 'other', note: 'x'.repeat(201) })).expect(400);
    expect(long.body.detail).toMatch(/200/);
    const ok = await move(body(PLAIN, 'A-01', 'L-01', 1, { reasonCode: 'other', note: '  shelf collapsed  ' })).expect(201);
    const events = await movedEvents(ok.body.moveId as string);
    expect(events[0]!.reference_doc).toEqual({ kind: 'bin-move', moveId: ok.body.moveId, reasonCode: 'other', note: 'shelf collapsed' });
    // Every vocabulary code is accepted.
    for (const reasonCode of MOVE_REASON_CODES.filter((code) => code !== 'other')) {
      await move(body(PLAIN, 'A-01', 'L-01', 1, { reasonCode })).expect(201);
    }
  });

  it('replay: the same key with a different payload → 422 idempotency-key-reuse; a web occurredAt → 400', async () => {
    const key = ulid();
    await move(body(PLAIN, 'A-01', 'L-01', 1), opsToken, key).expect(201);
    const reuse = await move(body(PLAIN, 'A-01', 'L-01', 2), opsToken, key).expect(422);
    expect(reuse.body.code).toBe('idempotency-key-reuse');
    const webTime = await move(body(PLAIN, 'A-01', 'L-01', 1, { occurredAt: new Date().toISOString() })).expect(400);
    expect(webTime.body.detail).toMatch(/handheld only/);
  });

  it('accountant: no stock.move → 403', async () => {
    const res = await move(body(PLAIN, 'A-01', 'L-01', 1), accountantToken).expect(403);
    expect(res.body.code).toBe('role-denied');
  });

  // ── concurrency ───────────────────────────────────────────────────────────

  describe('the same-key race: the replay under the bin locks', () => {
    const handle = () => postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    const outcome = (res: request.Response): number | string => (res.status === 201 ? 201 : `${res.status} ${(res.body as { code?: string }).code}`);

    async function waitParked(holderPid: number, min: number): Promise<void> {
      const probe = handle();
      try {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const waiting = (await probe`
            select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
            where a.wait_event_type = 'Lock' and a.state = 'active'
              and a.query ilike '%"bins"%' and a.query ilike '%for update%'
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
        throw new Error(`fewer than ${min} request(s) parked on the bins row`);
      } finally {
        await probe.end();
      }
    }

    it('two same-key moves parked on the origin lock both answer the same body — one move, one key', async () => {
      const key = ulid();
      const payload = body(PLAIN2, 'B-01', 'Y-01', 2);
      const holder = handle();
      let first: Promise<request.Response> | undefined;
      let second: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const locked = (await tx`
            select pg_backend_pid() as pid from bins where tenant_id = ${tenantId} and id = ${bin('B-01')} for update`) as unknown as { pid: number }[];
          first = (async () => move(payload, opsToken, key))();
          second = (async () => move(payload, opsToken, key))();
          await waitParked(locked[0]!.pid, 2);
        });
        const [a, b] = await Promise.all([first!, second!]);
        expect([a, b].map(outcome)).toEqual([201, 201]);
        expect(b.body).toEqual(a.body);
        expect(await count('ledger_events', "and type = 'stock.moved' and reference_doc->>'moveId' = $2", [a.body.moveId])).toBe(1);
        expect(await count('ledger_events', "and type = 'stock.moved' and sku_id = $2", [sku(PLAIN2)])).toBe(1);
        expect(await count('idempotency_keys', 'and key = $2', [key])).toBe(1);
        expect(await onHand(PLAIN2, 'Y-01')).toBe(2);
      } finally {
        await Promise.allSettled([first, second]);
        await holder.end();
      }
    });

    it('opposite concurrent moves A→B and B→A do not deadlock', async () => {
      const results = await Promise.all([
        move(body(PLAIN2, 'B-01', 'Y-01', 1)),
        move(body(PLAIN2, 'Y-01', 'B-01', 1)),
        move(body(PLAIN2, 'B-01', 'Y-01', 1)),
        move(body(PLAIN2, 'Y-01', 'B-01', 1)),
      ]);
      expect(results.map((res) => res.status)).toEqual([201, 201, 201, 201]);
      expect((await onHand(PLAIN2, 'B-01')) + (await onHand(PLAIN2, 'Y-01'))).toBe(10);
    });
  });

  // ── the device ───────────────────────────────────────────────────────────

  it('a device move: badge-in operator, occurredAt as sent; replay re-serves; a bare device credential and a missing occurredAt are refused', async () => {
    const key = ulid();
    const occurredAt = new Date(Date.now() - 120_000).toISOString();
    const payload = body(PLAIN, 'A-01', 'R-01', 2, { reasonCode: 'make-room', occurredAt });
    const res = await move(payload, deviceToken, key).expect(201);
    expect(res.body.events[0].occurredAt).toBe(occurredAt);
    await expectAuditRow({ tenantId, key, action: 'stock.moved', targetType: 'bin_move', targetId: res.body.moveId as string, actorUserId: operatorUserId });
    const replay = await move(payload, deviceToken, key).expect(201);
    expect(replay.body).toEqual(res.body);
    const { occurredAt: _omit, ...noTime } = payload;
    void _omit;
    const missing = await move(noTime, deviceToken).expect(400);
    expect(missing.body.detail).toMatch(/occurredAt is required/);
    const mismatch = await move(payload, deviceToken).set('X-Op-Operator', ownerUserId).expect(409);
    expect(mismatch.body.code).toBe('operator-mismatch');
  });

  it('hash goldens: the web and the device fingerprints, key by key', async () => {
    const webKey = ulid();
    const web = body(PLAIN, 'A-01', 'R-01', 1, { reasonCode: 'other', note: 'golden' });
    await move(web, opsToken, webKey).expect(201);
    const webHash = hashCommandPayload({
      surface: 'web',
      tenantId,
      deviceId: null,
      operatorUserId: opsUserId,
      warehouseId,
      skuId: sku(PLAIN),
      batchCode: null,
      qty: 1,
      fromBinId: bin('A-01'),
      toBinId: bin('R-01'),
      reasonCode: 'other',
      note: 'golden',
      serials: null,
    });
    expect((await sql<{ payload_hash: string }[]>`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${webKey}`)[0]!.payload_hash).toBe(webHash);

    const deviceKey = ulid();
    const occurredAt = '2026-10-20T08:30:00.000Z';
    await move(body(BSERIAL, 'X-01', 'E-01', 2, { serials: ['S2', 'S1'], occurredAt }), deviceToken, deviceKey).expect(201);
    const deviceHash = hashCommandPayload({
      surface: 'device',
      tenantId,
      deviceId,
      operatorUserId,
      warehouseId,
      skuId: sku(BSERIAL),
      batchCode: null,
      qty: 2,
      fromBinId: bin('X-01'),
      toBinId: bin('E-01'),
      reasonCode: 'consolidate',
      note: null,
      serials: ['S1', 'S2'],
      occurredAt,
    });
    expect((await sql<{ payload_hash: string }[]>`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${deviceKey}`)[0]!.payload_hash).toBe(deviceHash);
  });

  it('review: a refused stock.move op uploaded by the device — Apply re-runs it under the op\'s operator, Discard writes nothing', async () => {
    const upload = (rows: Record<string, unknown>[]) =>
      http().post(`${API}/${tenantId}/devices/sync-reports`).set('Authorization', `Bearer ${deviceToken}`).set(KEY_HEADER, ulid()).send({ rows });
    const row = (payload: Record<string, unknown>) => ({
      opId: ulid(),
      opType: 'stock.move',
      classification: 'quarantined',
      problemCode: 'bin-blocked',
      problemDetail: 'Bin "T-BLOCK" is blocked',
      payload,
      attribution: { deviceLabel: 'move-suite device', operatorEmail: 'op@example.com' },
      opEnqueuedAt: new Date(Date.now() - 60_000).toISOString(),
      opOccurredAt: null,
    });
    await seed(PLAIN, 'A-01', 5);
    const occurredAt = new Date(Date.now() - 90_000).toISOString();
    const applyRow = row({ warehouseId, skuId: sku(PLAIN), fromBinId: bin('A-01'), toBinId: bin('L-01'), qty: 2, batchCode: null, serials: null, reasonCode: 'found-misplaced', note: null, occurredAt });
    const discardRow = row({ warehouseId, skuId: sku(PLAIN), fromBinId: bin('A-01'), toBinId: bin('T-BLOCK'), qty: 1, batchCode: null, serials: null, reasonCode: 'consolidate', note: null, occurredAt });
    await upload([applyRow, discardRow]).expect(201);
    const listed = (await http().get(`${API}/${tenantId}/rejected-ops?status=open`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body.items as {
      id: string;
      opId: string;
      decisions: string[];
    }[];
    const applyEntry = listed.find((item) => item.opId === applyRow.opId)!;
    const discardEntry = listed.find((item) => item.opId === discardRow.opId)!;
    expect(applyEntry.decisions).toEqual(['apply', 'discard']);
    const recount = await http()
      .post(`${API}/${tenantId}/rejected-ops/${applyEntry.id}/resolve`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ decision: 'recount' })
      .expect(409);
    expect(recount.body.code).toBe('decision-not-available');

    const before = await onHand(PLAIN, 'L-01');
    const applied = await http()
      .post(`${API}/${tenantId}/rejected-ops/${applyEntry.id}/resolve`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ decision: 'apply' });
    expect([applied.status, applied.body.code, applied.body.detail]).toEqual([200, undefined, undefined]);
    expect(applied.body.rejectedOp.status).toBe('applied');
    expect(applied.body.outcome.command).toBe('stock.move');
    const moveId = applied.body.outcome.snapshot.moveId as string;
    // The applied events keep the op's own business time.
    expect((applied.body.outcome.snapshot.events as { occurredAt: string }[]).map((e) => e.occurredAt)).toEqual([occurredAt]);
    expect(await onHand(PLAIN, 'L-01')).toBe(before + 2);
    // The op's own key, the op's operator as the actor.
    await expectAuditRow({ tenantId, key: applyRow.opId, action: 'stock.moved', targetType: 'bin_move', targetId: moveId, actorUserId: operatorUserId });

    // The blocked target still refuses on Apply — the row stays open; Discard closes it with nothing written.
    const refused = await http()
      .post(`${API}/${tenantId}/rejected-ops/${discardEntry.id}/resolve`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ decision: 'apply' })
      .expect(409);
    expect(refused.body.code).toBe('bin-blocked');
    const eventsBefore = await count('ledger_events', "and type = 'stock.moved'");
    const discarded = await http()
      .post(`${API}/${tenantId}/rejected-ops/${discardEntry.id}/resolve`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ decision: 'discard' })
      .expect(200);
    expect(discarded.body.rejectedOp.status).toBe('discarded');
    expect(await count('ledger_events', "and type = 'stock.moved'")).toBe(eventsBefore);
  });

  it('the snapshot carries the move reasons and each SKU\'s isKit', async () => {
    const res = await http().get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`).set('Authorization', `Bearer ${deviceToken}`).expect(200);
    expect(res.body.moveReasons).toEqual(MOVE_REASON_CODES.map((code) => ({ code, noteRequired: code === 'other' })));
    const items = res.body.skus as { id: string; isKit: boolean }[];
    expect(items.find((item) => item.id === sku(KIT))!.isKit).toBe(true);
    expect(items.find((item) => item.id === sku(PLAIN))!.isKit).toBe(false);
  });

  it('a bare device enrollment credential (no badge-in) is 401 unauthenticated on the move route', async () => {
    const res = await move(body(PLAIN, 'A-01', 'L-01', 1, { occurredAt: new Date().toISOString() }), bareDeviceToken).expect(401);
    expect(res.body.code).toBe('unauthenticated');
  });

  it('a malformed device occurredAt is 400 naming the field', async () => {
    const res = await move(body(PLAIN, 'A-01', 'L-01', 1, { occurredAt: '2026-13-40T09:00:00.000Z' }), deviceToken).expect(400);
    expect(res.body.code).toBe('validation-failed');
    expect(res.body.detail).toMatch(/occurredAt must be a Z-suffixed/);
  });

  it('a secure TARGET without secure.move is 403 role-denied; the ops manager may', async () => {
    const denied = await move(body(SECURE_SKU, 'W-01', 'S-SEC', 1), operatorToken).expect(403);
    expect(denied.body.code).toBe('role-denied');
    expect(denied.body.detail).toContain('secure.move');
    expect(await onHand(SECURE_SKU, 'W-01')).toBe(4);
    await move(body(SECURE_SKU, 'W-01', 'S-SEC', 1), opsToken).expect(201);
  });

  it('a serial-only (not batch-tracked) SKU moves one magnitude-1 event per serial, no batch arm', async () => {
    const res = await move(body(SERIAL_ONLY, 'Q-01', 'L-01', 1, { serials: ['T1'] })).expect(201);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({ quantity: 1, batchRef: null });
    expect(res.body.events[0].serialRef).not.toBeNull();
    expect(await onHand(SERIAL_ONLY, 'Q-01')).toBe(1);
    expect(await onHand(SERIAL_ONLY, 'L-01')).toBe(1);
  });

  it('a move leaves ATP and the reservation counters unchanged', async () => {
    const before = await inventory.atp(tenantId, warehouseId, sku(PLAIN2));
    await move(body(PLAIN2, 'B-01', 'Y-01', 1)).expect(201);
    const after = await inventory.atp(tenantId, warehouseId, sku(PLAIN2));
    expect(after).toEqual(before);
  });

  it('trimmed identity: a padded batch code and note move and hash as their trimmed values', async () => {
    const key = ulid();
    await move(body(BATCH, 'D-01', 'L-01', 1, { batchCode: '  L1 ', reasonCode: 'other', note: ' padded ' }), opsToken, key).expect(201);
    // The same move with the trimmed values replays under the same key.
    await move(body(BATCH, 'D-01', 'L-01', 1, { batchCode: 'L1', reasonCode: 'other', note: 'padded' }), opsToken, key).expect(201);
    expect(await count('idempotency_keys', 'and key = $2', [key])).toBe(1);
  });

  it('a concurrent debit caught at the fold (422 insufficient-on-hand) answers 409 move-source-short', async () => {
    const spy = jest
      .spyOn(inventory, 'appendLedgerEventInTx')
      .mockRejectedValueOnce(new ProblemException('insufficient-on-hand', 422, 'Short', 'Bin "A-01" currently holds 0.'));
    const res = await move(body(PLAIN2, 'B-01', 'Y-01', 1)).expect(409);
    spy.mockRestore();
    expect(res.body.code).toBe('move-source-short');
    expect(res.body.detail).toContain('B-01');
  });

  // ── allocated stock and the pick epoch (the AC) ────────────────────────────

  it('AC: a device pick holding the bin\'s pre-move epoch answers 409 pick-bin-short after the move moved the allocated stock', async () => {
    await seed(PICKED, 'L-01', 7);
    await inventory.rebuildReservationCounters(tenantId, warehouseId);
    const order = await http()
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, lines: [{ skuId: sku(PICKED), quantity: 7 }], destination: testAddress() })
      .expect(201);
    const policy = await http()
      .post(`${API}/${tenantId}/outbound/wave-policies`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, name: `mv-${ulid().slice(10, 18)}`, grouping: 'single' })
      .expect(201);
    const wave = await http()
      .post(`${API}/${tenantId}/outbound/waves`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, policyId: policy.body.policy.id, orderIds: [order.body.order.id] })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/outbound/waves/${wave.body.wave.id}/release`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const detail = await http().get(`${API}/${tenantId}/outbound/waves/${wave.body.wave.id}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    const line = detail.body.wave.picklists[0].lines[0] as { id: string; picklistId: string; skuId: string; binId: string; qty: number };
    expect(line.binId).toBe(bin('L-01'));
    const snapshot = await http().get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`).set('Authorization', `Bearer ${deviceToken}`).expect(200);
    const task = (snapshot.body.pickTasks as { picklistLineId: string; binStateEpoch: number | null }[]).find((t) => t.picklistLineId === line.id)!;
    expect(task.binStateEpoch).not.toBeNull();

    // Allocated stock may be moved: reservations carry no bin.
    await move(body(PICKED, 'L-01', 'R-01', 7)).expect(201);

    const short = await http()
      .post(`${API}/${tenantId}/outbound/picks`)
      .set('Authorization', `Bearer ${deviceToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        picklistId: line.picklistId,
        picklistLineId: line.id,
        skuId: line.skuId,
        binId: line.binId,
        qty: line.qty,
        occurredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        binStateEpoch: task.binStateEpoch,
      })
      .expect(409);
    expect(short.body.code).toBe('pick-bin-short');
  });

  it('reconcile: the replayed ledger equals the projections after every move', async () => {
    const report = await inventory.replay(tenantId, warehouseId);
    expect(report.divergences).toEqual([]);
    expect(report.matches).toBe(true);
  });

  it('the route is in the OpenAPI document with every documented arm', async () => {
    const doc = await http().get('/api/v1/openapi.json').expect(200);
    const op = (doc.body.paths as Record<string, Record<string, { responses: Record<string, unknown> }>>)['/tenants/{tenantId}/warehouses/{warehouseId}/inventory/moves']?.post;
    expect(op).toBeDefined();
    expect(Object.keys(op!.responses).sort()).toEqual(['201', '400', '401', '403', '404', '409', '422']);
  });
});
