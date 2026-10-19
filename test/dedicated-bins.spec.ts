import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';
import { binClientAccepts } from '../src/shared/primitives/client-bin';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';

// Story 1-5b — dedicated client bins: a bin dedicated to one client refuses
// other clients' stock in putaway, merge and transfer receive; the bin edit
// sets and clears the dedication under the 12-1 class-edit rule; the putaway
// suggestion prefers the SKU's client's own bins. Every row of the spec's
// I/O matrix is driven here over real HTTP.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

jest.setTimeout(30_000);

interface Bin {
  id: string;
  code: string;
  dedicatedClientId: string | null;
  systemOwned: boolean;
  storageClass: string;
}

interface Task {
  grnLineId: string;
  suggestedBin: { binId: string; binCode: string } | null;
  rationale: string;
}

describe('dedicated client bins (e2e, story 1-5b)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql;

  let tenantId: string;
  let ownerToken: string;
  let operatorToken: string;

  let selfClient: string;
  let glow: string;
  let susp: string;
  let dept: string;
  let selfSku: string; // S-1, the tenant's own
  let glowSku: string; // G-1, GlowCo's

  const http = () => request(app.getHttpServer());
  const auth = (req: SupertestTest, token = ownerToken) => req.set('Authorization', `Bearer ${token}`);
  const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('dedicated_bins');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Dedicated Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;

    const clients = await auth(http().get(`${API}/${tenantId}/clients`)).expect(200);
    selfClient = (clients.body.items as { id: string; systemOwned: boolean }[]).find((c) => c.systemOwned)!.id;
    glow = await createClient('GLOW', 'GlowCo');
    susp = await createClient('SUSP', 'Suspended Co');
    dept = await createClient('DEPT', 'Departed Co');
    await setClientStatus(susp, 'suspended');
    await setClientStatus(dept, 'departed');

    await importCsv(['S-1,Self one,pcs,1800,,,'], selfClient);
    await importCsv(['G-1,Glow one,pcs,1800,,,'], glow);
    const rows = (await sql`select id, code from skus where tenant_id = ${tenantId}`) as unknown as { id: string; code: string }[];
    selfSku = rows.find((row) => row.code === 'S-1')!.id;
    glowSku = rows.find((row) => row.code === 'G-1')!.id;

    operatorToken = await badgeInOperator();
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

  // ── fixtures ───────────────────────────────────────────────────────────────

  async function createClient(code: string, name: string): Promise<string> {
    const res = await auth(http().post(`${API}/${tenantId}/clients`)).set(KEY_HEADER, ulid()).send({ code, name }).expect(201);
    return res.body.client.id as string;
  }

  async function setClientStatus(clientId: string, status: string): Promise<void> {
    await auth(http().patch(`${API}/${tenantId}/clients/${clientId}/status`)).set(KEY_HEADER, ulid()).send({ status }).expect(200);
  }

  async function importCsv(rows: string[], clientId: string): Promise<void> {
    const csv = ['sku_code,name,uom,gst_rate,hsn,barcode,kit_components', ...rows].join('\n');
    await auth(http().post(`${API}/${tenantId}/catalog/imports`))
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', clientId)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
  }

  async function badgeInOperator(): Promise<string> {
    const minted = await auth(http().post(`${API}/${tenantId}/devices/enrollment-codes`)).set(KEY_HEADER, ulid()).expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Dedicated scanner', pin: '1357' })
      .expect(201);
    const operatorEmail = `operator-${ulid().toLowerCase()}@example.com`;
    const invited = await auth(http().post(`${API}/${tenantId}/users`))
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
    return badged.body.accessToken as string;
  }

  /** A fresh warehouse + zone, so each suggestion arm ranks only its own bins. */
  async function newWarehouse(): Promise<{ wh: string; zone: string }> {
    const wh = (
      await auth(http().post(`${API}/${tenantId}/warehouses`))
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `DB-${ulid().slice(14, 20).toUpperCase()}`, name: `Dedicated Depot ${ulid()}` })
        .expect(201)
    ).body.id as string;
    const zone = (
      await auth(http().post(`${API}/${tenantId}/warehouses/${wh}/zones`)).set(KEY_HEADER, ulid()).send({ code: 'Z', name: 'Zone Z' }).expect(201)
    ).body.id as string;
    return { wh, zone };
  }

  async function createBin(
    loc: { wh: string; zone: string },
    code: string,
    extra: Record<string, unknown> = {},
  ): Promise<Bin> {
    const res = await auth(http().post(`${API}/${tenantId}/warehouses/${loc.wh}/zones/${loc.zone}/bins`))
      .set(KEY_HEADER, ulid())
      .send({ code, capacity: 100, type: 'shelf', ...extra })
      .expect(201);
    return res.body as Bin;
  }

  function patchBin(wh: string, binId: string, body: Record<string, unknown>, key = ulid()): SupertestTest {
    return auth(http().patch(`${API}/${tenantId}/warehouses/${wh}/bins/${binId}`)).set(KEY_HEADER, key).send(body);
  }

  async function listBins(loc: { wh: string; zone: string }): Promise<Bin[]> {
    const res = await auth(http().get(`${API}/${tenantId}/warehouses/${loc.wh}/zones/${loc.zone}/bins`)).expect(200);
    return res.body.items as Bin[];
  }

  async function adjust(wh: string, binId: string, skuId: string, quantityDelta: number): Promise<void> {
    await auth(http().post(`${API}/${tenantId}/inventory/adjustments`))
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, skuId, binId, quantityDelta, reasonCode: 'stock-count', note: 'dedicated-bins seed' })
      .expect(201);
  }

  async function blindGrn(wh: string, skuId: string, qty: number): Promise<{ grnId: string; lineId: string }> {
    const res = await http()
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId: wh,
        poId: null,
        blindReasonCode: 'unannounced-delivery',
        occurredAt: now(),
        lines: [{ poLineId: null, skuId, batchCode: null, mfgDate: null, qty }],
      })
      .expect(201);
    const grn = res.body.goodsReceipt as { id: string; lines: { id: string }[] };
    return { grnId: grn.id, lineId: grn.lines[0]!.id };
  }

  function place(
    wh: string,
    grn: { grnId: string; lineId: string },
    skuId: string,
    qty: number,
    toBinId: string,
    reasonCode: string | null = null,
  ): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/putaway/placements`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, grnId: grn.grnId, grnLineId: grn.lineId, skuId, batchId: null, qty, toBinId, reasonCode, occurredAt: now() });
  }

  async function tasks(wh: string): Promise<Task[]> {
    const res = await auth(http().get(`${API}/${tenantId}/putaway/tasks?warehouseId=${wh}`)).expect(200);
    return res.body.items as Task[];
  }

  async function snapshot(wh: string): Promise<{
    bins: Bin[];
    putawayTasks: Task[];
    clients: { id: string; code: string; name: string }[];
  }> {
    const res = await http()
      .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${wh}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    return res.body;
  }

  // ── the predicate ──────────────────────────────────────────────────────────

  it('binClientAccepts: a shared bin accepts every client; a dedicated bin only its own', () => {
    expect(binClientAccepts(null, glow)).toBe(true);
    expect(binClientAccepts(glow, glow)).toBe(true);
    expect(binClientAccepts(glow, selfClient)).toBe(false);
  });

  // ── the bin edit: dedicate and clear ───────────────────────────────────────

  it('dedicates an empty bin: 200; the list, the device snapshot (bin + the client by name) and the outbox carry it; clear returns it to shared', async () => {
    const loc = await newWarehouse();
    const bin = await createBin(loc, 'E-01');
    expect(bin.dedicatedClientId).toBeNull();

    const res = await patchBin(loc.wh, bin.id, { dedicatedClientId: glow }).expect(200);
    expect(res.body).toMatchObject({ id: bin.id, dedicatedClientId: glow });
    expect((await listBins(loc)).find((row) => row.id === bin.id)!.dedicatedClientId).toBe(glow);

    // The device snapshot: the bin's client AND GlowCo's name (no SKU or
    // document of this warehouse references GlowCo — the bins arm does).
    const snap = await snapshot(loc.wh);
    expect(snap.bins.find((row) => row.id === bin.id)!.dedicatedClientId).toBe(glow);
    expect(snap.clients).toEqual(expect.arrayContaining([expect.objectContaining({ id: glow, code: 'GLOW', name: 'GlowCo' })]));

    const events = (await sql`
      select payload from outbox_messages
      where tenant_id = ${tenantId} and type = 'bin.capacity_changed' and payload->>'binId' = ${bin.id}`) as unknown as {
      payload: Record<string, unknown>;
    }[];
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ binId: bin.id, dedicatedClientId: glow });

    // Clear (decision 7 — always allowed): null is a structure edit, not a 400.
    const cleared = await patchBin(loc.wh, bin.id, { dedicatedClientId: null }).expect(200);
    expect(cleared.body.dedicatedClientId).toBeNull();
    expect((await listBins(loc)).find((row) => row.id === bin.id)!.dedicatedClientId).toBeNull();
  });

  it('refuses a dedication while the bin holds another client\'s stock (naming it), admits one over its own stock', async () => {
    const loc = await newWarehouse();
    const other = await createBin(loc, 'O-01');
    await adjust(loc.wh, other.id, selfSku, 2);
    const refused = await patchBin(loc.wh, other.id, { dedicatedClientId: glow }).expect(409);
    expect(refused.body.code).toBe('bin-client-conflict');
    expect(String(refused.body.detail)).toContain('S-1');
    expect(String(refused.body.detail)).toContain('stock on hand');
    expect((await listBins(loc)).find((row) => row.id === other.id)!.dedicatedClientId).toBeNull();

    const own = await createBin(loc, 'O-02');
    await adjust(loc.wh, own.id, glowSku, 2);
    await patchBin(loc.wh, own.id, { dedicatedClientId: glow }).expect(200);
  });

  it('refuses a dedication while another client\'s open QC hold originates in the bin (its units would return there)', async () => {
    const loc = await newWarehouse();
    const bin = await createBin(loc, 'H-01');
    await adjust(loc.wh, bin.id, selfSku, 2);
    await auth(http().post(`${API}/${tenantId}/receiving/qc-holds`))
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: loc.wh, skuId: selfSku, binId: bin.id, reason: 'Dented — inspect' })
      .expect(201);
    // The hold moved the units to QC-HOLD: the bin's own on-hand reads zero.
    const onHand = (await sql`
      select coalesce(sum(quantity), 0)::bigint as q from stock_on_hand where tenant_id = ${tenantId} and bin_id = ${bin.id}`) as unknown as { q: string }[];
    expect(Number(onHand[0]!.q)).toBe(0);

    const refused = await patchBin(loc.wh, bin.id, { dedicatedClientId: glow }).expect(409);
    expect(refused.body.code).toBe('bin-client-conflict');
    expect(String(refused.body.detail)).toContain('open QC holds');
    expect(String(refused.body.detail)).toContain('S-1');
  });

  it('a system bin cannot be dedicated (400); a null clear on it is harmless', async () => {
    const loc = await newWarehouse();
    await blindGrn(loc.wh, selfSku, 1); // ensures the Receiving bin
    const receiving = (await snapshot(loc.wh)).bins.find((row) => row.systemOwned && row.code === 'RECEIVING')!;
    const refused = await patchBin(loc.wh, receiving.id, { dedicatedClientId: glow }).expect(400);
    expect(refused.body.code).toBe('validation-failed');
    expect(String(refused.body.detail)).toContain('system bin');
    const cleared = await patchBin(loc.wh, receiving.id, { dedicatedClientId: null }).expect(200);
    expect(cleared.body.dedicatedClientId).toBeNull();
  });

  it('client checks: unknown 404, departed 409 client-departed, suspended allowed; a dedication to a since-departed client stays and keeps refusing', async () => {
    const loc = await newWarehouse();
    const bin = await createBin(loc, 'C-01');
    const unknown = await patchBin(loc.wh, bin.id, { dedicatedClientId: uuidv7() }).expect(404);
    expect(unknown.body.code).toBe('not-found');
    const departed = await patchBin(loc.wh, bin.id, { dedicatedClientId: dept }).expect(409);
    expect(departed.body.code).toBe('client-departed');
    await patchBin(loc.wh, bin.id, { dedicatedClientId: susp }).expect(200);

    // Dedicate to a client, THEN depart it: the dedication stays, an
    // unrelated structure edit still succeeds, and other clients' stock is
    // still refused.
    const leaving = await createClient('LEAV', 'Leaving Co');
    const kept = await createBin(loc, 'C-02');
    await patchBin(loc.wh, kept.id, { dedicatedClientId: leaving }).expect(200);
    await setClientStatus(leaving, 'departed');
    const edited = await patchBin(loc.wh, kept.id, { lengthMm: 900 }).expect(200);
    expect(edited.body.dedicatedClientId).toBe(leaving);
    const grn = await blindGrn(loc.wh, selfSku, 1);
    const refused = await place(loc.wh, grn, selfSku, 1, kept.id, 'operator-preference').expect(400);
    expect(refused.body.code).toBe('bin-client-mismatch');
  });

  it('when the class and the client both conflict, the class refusal answers first', async () => {
    const loc = await newWarehouse();
    const bin = await createBin(loc, 'K-01');
    await adjust(loc.wh, bin.id, selfSku, 1);
    const res = await patchBin(loc.wh, bin.id, { storageClass: 'hazardous', dedicatedClientId: glow }).expect(409);
    expect(res.body.code).toBe('storage-class-conflict');
  });

  it('the fingerprint: a body without the field hashes as before 1.5b; the same key with another client is 422; blocked + client is 400', async () => {
    const loc = await newWarehouse();
    const bin = await createBin(loc, 'F-01');

    // Golden: the pre-1.5b fingerprint of a storage-class edit — the absent
    // dedicatedClientId drops out of the JSON, so the stored hash is
    // byte-identical to what the 12-1 build wrote.
    const classKey = ulid();
    await patchBin(loc.wh, bin.id, { storageClass: 'chilled' }, classKey).expect(200);
    const stored = (await sql`
      select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${classKey}`) as unknown as { payload_hash: string }[];
    expect(stored[0]!.payload_hash).toBe(
      hashCommandPayload({ tenantId, warehouseId: loc.wh, binId: bin.id, storageClass: 'chilled' }),
    );

    const key = ulid();
    const first = await patchBin(loc.wh, bin.id, { dedicatedClientId: glow }, key).expect(200);
    const replay = await patchBin(loc.wh, bin.id, { dedicatedClientId: glow }, key).expect(200);
    expect(replay.body).toEqual(first.body);
    const reused = await patchBin(loc.wh, bin.id, { dedicatedClientId: susp }, key).expect(422);
    expect(reused.body.code).toBe('idempotency-key-reuse');

    const mixed = await patchBin(loc.wh, bin.id, { blocked: true, dedicatedClientId: null }).expect(400);
    expect(mixed.body.code).toBe('validation-failed');
    const malformed = await patchBin(loc.wh, bin.id, { dedicatedClientId: 'abc' }).expect(400);
    expect(malformed.body.code).toBe('validation-failed');
  });

  it('create and grid take an optional client (unknown 404, departed 409); absent is shared', async () => {
    const loc = await newWarehouse();
    const dedicated = await createBin(loc, 'N-01', { dedicatedClientId: glow });
    expect(dedicated.dedicatedClientId).toBe(glow);
    const shared = await createBin(loc, 'N-02');
    expect(shared.dedicatedClientId).toBeNull();
    const base = `${API}/${tenantId}/warehouses/${loc.wh}/zones/${loc.zone}/bins`;
    const unknown = await auth(http().post(base)).set(KEY_HEADER, ulid())
      .send({ code: 'N-03', capacity: 10, type: 'shelf', dedicatedClientId: uuidv7() }).expect(404);
    expect(unknown.body.code).toBe('not-found');
    const departed = await auth(http().post(base)).set(KEY_HEADER, ulid())
      .send({ code: 'N-04', capacity: 10, type: 'shelf', dedicatedClientId: dept }).expect(409);
    expect(departed.body.code).toBe('client-departed');

    // The generator dedicates a whole new grid (decision 1).
    await auth(http().post(`${base}/grid`)).set(KEY_HEADER, ulid())
      .send({ aisleFrom: 'M', aisleTo: 'M', baysPerAisle: 2, levelsPerBay: 1, capacity: 10, type: 'shelf', dedicatedClientId: glow })
      .expect(201);
    const grid = (await listBins(loc)).filter((row) => row.code.startsWith('M-'));
    expect(grid).toHaveLength(2);
    expect(grid.every((row) => row.dedicatedClientId === glow)).toBe(true);
    const departedGrid = await auth(http().post(`${base}/grid`)).set(KEY_HEADER, ulid())
      .send({ aisleFrom: 'P', aisleTo: 'P', baysPerAisle: 1, levelsPerBay: 1, capacity: 10, type: 'shelf', dedicatedClientId: dept })
      .expect(409);
    expect(departedGrid.body.code).toBe('client-departed');
  });

  // ── putaway: the suggestion and the placement gate ────────────────────────

  it('the suggestion prefers the SKU\'s own dedicated bin over an emptier shared one — task and placement agree, the rationale names the client, no reason needed', async () => {
    const loc = await newWarehouse();
    const sharedBin = await createBin(loc, 'B-01');
    const glowBin = await createBin(loc, 'B-02', { dedicatedClientId: glow });
    await adjust(loc.wh, glowBin.id, glowSku, 1); // the shared bin is the emptier one

    const grn = await blindGrn(loc.wh, glowSku, 3);
    const task = (await tasks(loc.wh)).find((row) => row.grnLineId === grn.lineId)!;
    expect(task.suggestedBin).toEqual({ binId: glowBin.id, binCode: 'B-02' });
    expect(task.rationale).toContain('Dedicated to GLOW');
    const deviceTask = (await snapshot(loc.wh)).putawayTasks.find((row) => row.grnLineId === grn.lineId)!;
    expect(deviceTask.suggestedBin).toEqual(task.suggestedBin);

    const placed = await place(loc.wh, grn, glowSku, 3, glowBin.id).expect(201);
    expect(placed.body.placement).toMatchObject({ toBinId: glowBin.id, suggestedBinId: glowBin.id, reasonCode: null });
    expect(sharedBin.dedicatedClientId).toBeNull();
  });

  it('another client\'s bin is never suggested even when emptiest, and a placement into it is refused 400 bin-client-mismatch; own goods may still go to a shared bin', async () => {
    const loc = await newWarehouse();
    const sharedBin = await createBin(loc, 'X-01');
    await adjust(loc.wh, sharedBin.id, selfSku, 5); // GlowCo's bin is the emptiest
    const glowBin = await createBin(loc, 'X-02', { dedicatedClientId: glow });

    const selfGrn = await blindGrn(loc.wh, selfSku, 2);
    const selfTask = (await tasks(loc.wh)).find((row) => row.grnLineId === selfGrn.lineId)!;
    expect(selfTask.suggestedBin).toEqual({ binId: sharedBin.id, binCode: 'X-01' });
    expect(selfTask.rationale).not.toContain('Dedicated');

    const refused = await place(loc.wh, selfGrn, selfSku, 2, glowBin.id, 'operator-preference').expect(400);
    expect(refused.body.code).toBe('bin-client-mismatch');
    expect(String(refused.body.detail)).toContain('X-02');
    expect(String(refused.body.detail)).toContain('GLOW');
    expect(String(refused.body.detail)).toContain('S-1');
    // Own goods into a shared bin: allowed (preference, not exclusivity) —
    // with a reason, because the suggestion is GlowCo's own bin.
    const glowGrn = await blindGrn(loc.wh, glowSku, 1);
    await place(loc.wh, glowGrn, glowSku, 1, sharedBin.id, 'operator-preference').expect(201);
    await place(loc.wh, selfGrn, selfSku, 2, sharedBin.id).expect(201);
  });

  it('a stale suggestion followed: a task suggested a shared bin before another bin was dedicated — placing there with no reason still succeeds', async () => {
    const loc = await newWarehouse();
    const first = await createBin(loc, 'S-01');
    const second = await createBin(loc, 'S-02');
    const grn = await blindGrn(loc.wh, glowSku, 2);
    expect((await tasks(loc.wh)).find((row) => row.grnLineId === grn.lineId)!.suggestedBin?.binId).toBe(first.id);

    // A bin is dedicated to GlowCo after the task was derived: the preferred
    // walk now picks it, but the handheld still carries the old suggestion.
    await patchBin(loc.wh, second.id, { dedicatedClientId: glow }).expect(200);
    expect((await tasks(loc.wh)).find((row) => row.grnLineId === grn.lineId)!.suggestedBin?.binId).toBe(second.id);

    const placed = await place(loc.wh, grn, glowSku, 2, first.id).expect(201);
    expect(placed.body.placement).toMatchObject({ toBinId: first.id, suggestedBinId: first.id, reasonCode: null });
  });

  // ── merge and transfer receive ─────────────────────────────────────────────

  it('merge refuses moving another client\'s stock into a dedicated bin (400), nothing committed', async () => {
    const loc = await newWarehouse();
    const source = await createBin(loc, 'G-01');
    await adjust(loc.wh, source.id, selfSku, 3);
    const target = await createBin(loc, 'G-02', { dedicatedClientId: glow });
    const res = await auth(http().post(`${API}/${tenantId}/warehouses/${loc.wh}/bins/${source.id}/merge`))
      .set(KEY_HEADER, ulid())
      .send({ targetBinId: target.id })
      .expect(400);
    expect(res.body.code).toBe('bin-client-mismatch');
    const rows = (await sql`select retired_at from bins where id = ${source.id}`) as unknown as { retired_at: string | null }[];
    expect(rows[0]!.retired_at).toBeNull();
  });

  it('transfer receive refuses landing another client\'s line in a dedicated bin (409); the landing-bin override recovers it', async () => {
    const loc = await newWarehouse();
    const source = await createBin(loc, 'T-01');
    await adjust(loc.wh, source.id, selfSku, 4);
    const glowBin = await createBin(loc, 'T-02', { dedicatedClientId: glow });
    const other = await createBin(loc, 'T-03');

    // Gated at receive, never at create (decision 12).
    const created = await auth(http().post(`${API}/${tenantId}/movements/transfers`))
      .set(KEY_HEADER, ulid())
      .send({
        sourceWarehouseId: loc.wh,
        destWarehouseId: loc.wh,
        lines: [{ skuId: selfSku, quantity: 2, fromBinId: source.id, toBinId: glowBin.id }],
      })
      .expect(201);
    const transferId = created.body.transfer.id as string;
    await auth(http().post(`${API}/${tenantId}/movements/transfers/${transferId}/outbound-confirm`)).set(KEY_HEADER, ulid()).send({}).expect(200);
    const refused = await auth(http().post(`${API}/${tenantId}/movements/transfers/${transferId}/inbound-confirm`))
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(409);
    expect(refused.body.code).toBe('bin-client-mismatch');
    expect(String(refused.body.detail)).toContain('T-02');
    await auth(http().post(`${API}/${tenantId}/movements/transfers/${transferId}/inbound-confirm`))
      .set(KEY_HEADER, ulid())
      .send({ destBinId: other.id })
      .expect(200);
  });

  // ── the QC release race ────────────────────────────────────────────────────

  it('a dedication and a QC release of another client\'s hold into the bin serialise on the bin row — the dedication is refused either way', async () => {
    const loc = await newWarehouse();
    const bin = await createBin(loc, 'R-01');
    await adjust(loc.wh, bin.id, selfSku, 2);
    const hold = await auth(http().post(`${API}/${tenantId}/receiving/qc-holds`))
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: loc.wh, skuId: selfSku, binId: bin.id, reason: 'Race — inspect' })
      .expect(201);
    const holdId = hold.body.qcHold.id as string;

    const handle = () => postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
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
        throw new Error(`fewer than ${min} request(s) parked on the bin row`);
      } finally {
        await probe.end();
      }
    }

    const holder = handle();
    let release: Promise<request.Response> | undefined;
    let dedicate: Promise<request.Response> | undefined;
    try {
      await holder.begin(async (tx) => {
        const locked = (await tx`
          select pg_backend_pid() as pid from bins where tenant_id = ${tenantId} and id = ${bin.id} for update
        `) as unknown as { pid: number }[];
        // The release parks on the origin bin's row lock (the PENDING fix —
        // without `.for('update')` on the origin read it would not park and
        // this wait would time out), then the dedication parks behind it.
        release = (async () =>
          auth(http().post(`${API}/${tenantId}/receiving/qc-holds/${holdId}/release`)).set(KEY_HEADER, ulid()).send({}))();
        await waitParked(locked[0]!.pid, 1);
        dedicate = (async () => patchBin(loc.wh, bin.id, { dedicatedClientId: glow }))();
        await waitParked(locked[0]!.pid, 2);
      });
      const [released, dedicated] = await Promise.all([release!, dedicate!]);
      expect(released.status).toBe(200);
      expect(dedicated.status).toBe(409);
      expect(dedicated.body.code).toBe('bin-client-conflict');
    } finally {
      await Promise.allSettled([release, dedicate]);
      await holder.end();
    }
    const rows = (await sql`select dedicated_client_id from bins where id = ${bin.id}`) as unknown as { dedicated_client_id: string | null }[];
    expect(rows[0]!.dedicated_client_id).toBeNull();
  });
});
