import type { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { istDateOf } from '../src/shared/primitives/time';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { Database } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { ensureQcHoldBinInTx } from '../src/modules/tenancy/receiving-bin';
import { signTenantSession } from '../src/modules/tenancy/jwt-session';
import { TenancyController } from '../src/modules/tenancy/tenancy.controller';
import { binLabelsFilename, compareBinsForLabels } from '../src/modules/tenancy/bin-labels';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { mintSignIn } from './support/sign-in';
import { testAddress } from './support/shipment-address';
import { parseZplLabels, readPdfLabels } from './support/labels';

// Story 2-10a — bin labels: `POST …/warehouses/{w}/bins/labels` answers ZPL
// or PDF, refuses before the first byte (problem+json), and every printed
// barcode decodes to exactly the bin code.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;

jest.setTimeout(120_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';

/** supertest: collect the body as raw bytes, whatever the content type. */
function binary(res: NodeJS.ReadableStream & { setEncoding(e: string): void }, done: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => done(null, Buffer.concat(chunks)));
}

describe('bin labels (e2e, story 2-10a)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  const http = () => request(app.getHttpServer());

  let tenantId: string;
  let ownerUserId: string;
  let ownerToken: string;
  let warehouseId: string;
  let warehouseCode: string;
  let zoneA: string; // the main zone
  let zoneEmpty: string;
  let zoneRetiredOnly: string;
  const bins = new Map<string, string>(); // code → id

  // A second tenant (isolation).
  let otherTenantId: string;
  let otherToken: string;
  let otherWarehouseId: string;
  let otherBinId: string;

  async function signIn(email: string): Promise<string> {
    return (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
  }

  async function register(label: string): Promise<{ tenantId: string; userId: string; token: string }> {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const res = await http().post(API).set(KEY_HEADER, ulid()).send({ name: `Labels ${label} ${ulid()}`, ownerEmail: email, password: PASSWORD }).expect(201);
    return { tenantId: res.body.tenant.id as string, userId: res.body.owner.id as string, token: await signIn(email) };
  }

  async function invite(role: string): Promise<string> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role })
      .expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
    return signIn(email);
  }

  async function createWarehouse(token: string, inTenant: string, code: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${inTenant}/warehouses`)
        .set('Authorization', `Bearer ${token}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code, name: `Labels depot ${ulid()}` })
        .expect(201)
    ).body.id as string;
  }

  async function createZone(code: string, inWarehouse = warehouseId, token = ownerToken, inTenant = tenantId): Promise<string> {
    return (
      await http()
        .post(`${API}/${inTenant}/warehouses/${inWarehouse}/zones`)
        .set('Authorization', `Bearer ${token}`)
        .set(KEY_HEADER, ulid())
        .send({ code, name: `Zone ${code}` })
        .expect(201)
    ).body.id as string;
  }

  async function createBin(code: string, zoneId = zoneA, extra: Record<string, unknown> = {}, inWarehouse = warehouseId, token = ownerToken, inTenant = tenantId): Promise<string> {
    const id = (
      await http()
        .post(`${API}/${inTenant}/warehouses/${inWarehouse}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${token}`)
        .set(KEY_HEADER, ulid())
        .send({ code, capacity: 100, type: 'shelf', ...extra })
        .expect(201)
    ).body.id as string;
    if (inTenant === tenantId) bins.set(code, id);
    return id;
  }

  async function retire(binId: string): Promise<void> {
    await http()
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${binId}/retire`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(200);
  }

  function print(body: Record<string, unknown>, token = ownerToken, inWarehouse = warehouseId, inTenant = tenantId): request.Test {
    return http()
      .post(`${API}/${inTenant}/warehouses/${inWarehouse}/bins/labels`)
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .buffer(true)
      .parse(binary as never);
  }

  function problemOf(res: request.Response): Record<string, unknown> {
    return JSON.parse((res.body as Buffer).toString('utf8')) as Record<string, unknown>;
  }

  async function refusal(res: request.Test, status: number): Promise<Record<string, unknown>> {
    const r = await res;
    expect(r.status).toBe(status);
    expect(r.headers['content-type']).toMatch(/^application\/problem\+json/);
    return problemOf(r);
  }

  const ids = (...codes: string[]): string[] => codes.map((c) => bins.get(c)!);

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('bin_labels');
    app = await createApp(false);
    await app.init();

    const owner = await register('main');
    tenantId = owner.tenantId;
    ownerUserId = owner.userId;
    ownerToken = owner.token;
    warehouseCode = `BL-${ulid().slice(20, 24)}`;
    warehouseId = await createWarehouse(ownerToken, tenantId, warehouseCode);
    zoneA = await createZone('A');
    zoneEmpty = await createZone('EMPTY');
    zoneRetiredOnly = await createZone('GONE');

    for (const code of ['A-2', 'A-10', 'A-1', 'A-01', 'A^1~_>B', 'Ä-01', 'TOO-LONG-CODE', 'A4-TOO-LONG-CODE-XYZ']) await createBin(code);
    const clientId = (
      await http().post(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code: 'ACME', name: 'Acme Brands' }).expect(201)
    ).body.client.id as string;
    await createBin('C-01', zoneA, { storageClass: 'chilled', dedicatedClientId: clientId });
    await createBin('R-01');
    await retire(bins.get('R-01')!);
    await createBin('R-02', zoneRetiredOnly);
    await retire(bins.get('R-02')!);

    const other = await register('other');
    otherTenantId = other.tenantId;
    otherToken = other.token;
    otherWarehouseId = await createWarehouse(otherToken, otherTenantId, `OT-${ulid().slice(20, 24)}`);
    const otherZone = await createZone('A', otherWarehouseId, otherToken, otherTenantId);
    otherBinId = await createBin('A-1', otherZone, {}, otherWarehouseId, otherToken, otherTenantId);
  });

  afterAll(async () => {
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  // ── the happy paths ─────────────────────────────────────────────────────

  it('ZPL by ids: text/plain, one ^XA…^XZ per bin sorted by code, each payload exactly the code', async () => {
    const res = await print({ binIds: ids('A-10', 'A-2', 'C-01'), format: 'zpl', size: '4x2' }).expect(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=us-ascii');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.etag).toBeUndefined();
    const today = istDateOf(new Date().toISOString()).replace(/-/g, '');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="bin-labels-${warehouseCode}-${today}.zpl"`);
    const zpl = (res.body as Buffer).toString('ascii');
    expect(Number(res.headers['content-length'])).toBe((res.body as Buffer).length);
    const labels = parseZplLabels(zpl);
    expect(labels.map((l) => l.payload)).toEqual(['A-2', 'A-10', 'C-01']);
    expect(labels[0]!.raw).toContain('^PW812');
    // The zone and warehouse line, and the small line only on the chilled, dedicated bin.
    expect(labels[0]!.raw).toContain(`^FDA - ${warehouseCode}^FS`);
    expect(labels[0]!.raw).not.toContain('CLIENT');
    expect(labels[2]!.raw).toContain('^FDCHILLED | CLIENT ACME^FS');
  });

  it('special characters: A^1~_>B is escaped in the ZPL and decodes to itself, in ZPL and PDF', async () => {
    const zpl = (await print({ binIds: ids('A^1~_>B'), format: 'zpl', size: '2x1' }).expect(200)).body as Buffer;
    const [label] = parseZplLabels(zpl.toString('ascii'));
    expect(label!.payload).toBe('A^1~_>B');
    expect(label!.raw).toContain('^FD>:A_5E1_7E_5F><B^FS');
    const pdf = (await print({ binIds: ids('A^1~_>B'), format: 'pdf' }).expect(200)).body as Buffer;
    expect((await readPdfLabels(pdf))[0]!.payloads).toEqual(['A^1~_>B']);
  });

  it('PDF label pages, 2x1: two pages of 144 × 72 pt in code order', async () => {
    const res = await print({ binIds: ids('A-2', 'A-1'), format: 'pdf', layout: 'label', size: '2x1' }).expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/filename="bin-labels-.+-\d{8}\.pdf"$/);
    const pages = await readPdfLabels(res.body as Buffer);
    expect(pages).toEqual([
      { width: 144, height: 72, payloads: ['A-1'] },
      { width: 144, height: 72, payloads: ['A-2'] },
    ]);
  });

  it('the sort: numeric collation, ties (A-01 / A-1) by plain code comparison, then id', async () => {
    const res = await print({ binIds: ids('A-10', 'A-1', 'A-2', 'A-01'), format: 'zpl' }).expect(200);
    expect(parseZplLabels((res.body as Buffer).toString('ascii')).map((l) => l.payload)).toEqual(['A-01', 'A-1', 'A-2', 'A-10']);
    // The id tie-break (two equal codes cannot share a warehouse, so it is pinned on the comparator).
    const a = { code: 'X-1', id: '00000000-0000-7000-8000-000000000001' };
    const b = { code: 'X-1', id: '00000000-0000-7000-8000-000000000002' };
    expect([b, a].sort(compareBinsForLabels)).toEqual([a, b]);
  });

  it('PDF A4 by zone: 30 printable bins are 2 A4 pages (24 + 6) in code order; retired bins are skipped', async () => {
    const zone30 = await createZone('Z30');
    const codes = Array.from({ length: 30 }, (_v, i) => `Z-${i + 1}`);
    for (const code of [...codes].reverse()) await createBin(code, zone30);
    await createBin('Z-RET', zone30);
    await retire(bins.get('Z-RET')!);
    const res = await print({ zoneId: zone30, format: 'pdf', layout: 'a4' }).expect(200);
    const pages = await readPdfLabels(res.body as Buffer);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.width).toBeCloseTo(595.28, 1);
    expect(pages[0]!.height).toBeCloseTo(841.89, 1);
    expect(pages[0]!.payloads).toEqual(codes.slice(0, 24));
    expect(pages[1]!.payloads).toEqual(codes.slice(24));
  });

  // ── the refusals ────────────────────────────────────────────────────────

  it('not barcodable: a non-ASCII code is 422 bin-code-not-barcodable naming it', async () => {
    const body = await refusal(print({ binIds: ids('A-1', 'Ä-01'), format: 'zpl' }), 422);
    expect(body).toMatchObject({ code: 'bin-code-not-barcodable', binCodes: ['Ä-01'] });
    expect(body.detail).toContain('"Ä-01"');
  });

  it('too long: a 13-character code fits 4x2 but not 2x1 (11) — 422 bin-code-too-long-for-label', async () => {
    await print({ binIds: ids('TOO-LONG-CODE'), format: 'zpl', size: '4x2' }).expect(200);
    const body = await refusal(print({ binIds: ids('TOO-LONG-CODE', 'A-1'), format: 'pdf', size: '2x1' }), 422);
    expect(body).toMatchObject({ code: 'bin-code-too-long-for-label', binCodes: ['TOO-LONG-CODE'] });
    expect(body.detail).toContain('11 characters at most');
  });

  it('too long for an A4 cell: a 20-character code fits 4x2 (28) but not A4 (18)', async () => {
    await print({ binIds: ids('A4-TOO-LONG-CODE-XYZ'), format: 'zpl', size: '4x2' }).expect(200);
    const body = await refusal(print({ binIds: ids('A4-TOO-LONG-CODE-XYZ', 'A-1'), format: 'pdf', layout: 'a4' }), 422);
    expect(body).toMatchObject({ code: 'bin-code-too-long-for-label', binCodes: ['A4-TOO-LONG-CODE-XYZ'] });
    expect(body.detail).toContain('18 characters at most');
  });

  it('ids compare case-insensitively: an upper-case id prints; the same id in two cases is a 400 duplicate', async () => {
    const id = bins.get('A-1')!;
    const res = await print({ binIds: [id.toUpperCase()], format: 'zpl' }).expect(200);
    expect(parseZplLabels((res.body as Buffer).toString('ascii')).map((l) => l.payload)).toEqual(['A-1']);
    expect(await refusal(print({ binIds: [id, id.toUpperCase()], format: 'zpl' }), 400)).toMatchObject({ code: 'validation-failed' });
  });

  it('null counts as absent: binIds or zoneId null alone is 400; null beside the other takes the other path', async () => {
    expect(await refusal(print({ binIds: null, format: 'zpl' }), 400)).toMatchObject({ code: 'validation-failed' });
    expect(await refusal(print({ zoneId: null, format: 'zpl' }), 400)).toMatchObject({ code: 'validation-failed' });
    expect(await refusal(print({ binIds: null, zoneId: null, format: 'zpl' }), 400)).toMatchObject({ code: 'validation-failed' });
    // Reaches the zone path (zone A holds an unbarcodable code, so the empty zone is the clean probe).
    expect(await refusal(print({ binIds: null, zoneId: zoneEmpty, format: 'zpl' }), 404)).toMatchObject({ code: 'no-bins-to-print' });
    await print({ binIds: ids('A-1'), zoneId: null, format: 'zpl' }).expect(200);
  });

  it('retired and system ids: 422 bin-retired, then bin-not-printable, each with binCodes; matrix order', async () => {
    const retired = await refusal(print({ binIds: ids('R-01', 'A-1', 'Ä-01'), format: 'zpl' }), 422);
    // Retired is checked before barcodable.
    expect(retired).toMatchObject({ code: 'bin-retired', binCodes: ['R-01'] });
    const db = app.get<Database>(DATABASE);
    const qc = await withTenantTransaction(db, tenantId, (tx) => ensureQcHoldBinInTx(tx, tenantId, warehouseId));
    const system = await refusal(print({ binIds: [qc.binId, bins.get('A-1')!], format: 'zpl' }), 422);
    expect(system).toMatchObject({ code: 'bin-not-printable', binCodes: ['QC-HOLD'] });
    // A system zone prints nothing (its only bin is a system bin).
    expect(await refusal(print({ zoneId: qc.zoneId, format: 'zpl' }), 404)).toMatchObject({ code: 'no-bins-to-print' });
  });

  it('the listing arms carry at most 50 codes, the detail counting the rest', async () => {
    const zoneMany = await createZone('MANY');
    const many: string[] = [];
    for (let i = 0; i < 53; i += 1) many.push(await createBin(`M-${i + 1}`, zoneMany));
    await Promise.all(many.map(async (id) => retire(id)));
    const body = await refusal(print({ binIds: many, format: 'zpl' }), 422);
    expect(body.code).toBe('bin-retired');
    expect((body.binCodes as string[]).length).toBe(50);
    expect((body.binCodes as string[]).slice(0, 3)).toEqual(['M-1', 'M-2', 'M-3']);
    expect(body.detail).toMatch(/ \+3 more\.$/);
  });

  it('foreign or unknown: warehouse, zone or bin outside the tenant or warehouse is 404 not-found', async () => {
    expect(await refusal(print({ binIds: ids('A-1'), format: 'zpl' }, ownerToken, uuidv7()), 404)).toMatchObject({ code: 'not-found' });
    expect(await refusal(print({ binIds: [uuidv7()], format: 'zpl' }), 404)).toMatchObject({ code: 'not-found' });
    expect(await refusal(print({ zoneId: uuidv7(), format: 'zpl' }), 404)).toMatchObject({ code: 'not-found' });
    // A bin of another warehouse of the same tenant.
    const wh2 = await createWarehouse(ownerToken, tenantId, `B2-${ulid().slice(20, 24)}`);
    const z2 = await createZone('A', wh2);
    const b2 = await createBin('W2-1', z2, {}, wh2);
    expect(await refusal(print({ binIds: [b2], format: 'zpl' }), 404)).toMatchObject({ code: 'not-found' });
    expect(await refusal(print({ zoneId: z2, format: 'zpl' }), 404)).toMatchObject({ code: 'not-found' });
  });

  it('tenant isolation: another tenant cannot reach this warehouse or its bins, nor the path', async () => {
    // Its own path, our warehouse → 404 (not ours to confirm).
    expect(await refusal(print({ binIds: ids('A-1'), format: 'zpl' }, otherToken, warehouseId, otherTenantId), 404)).toMatchObject({ code: 'not-found' });
    // Its own warehouse, our bins → 404.
    expect(await refusal(print({ binIds: ids('A-1'), format: 'zpl' }, otherToken, otherWarehouseId, otherTenantId), 404)).toMatchObject({ code: 'not-found' });
    // Our path with its token → 403 permission-denied.
    expect(await refusal(print({ binIds: [otherBinId], format: 'zpl' }, otherToken), 403)).toMatchObject({ code: 'permission-denied' });
    // And it prints its own bin.
    const own = await print({ binIds: [otherBinId], format: 'zpl' }, otherToken, otherWarehouseId, otherTenantId).expect(200);
    expect(parseZplLabels((own.body as Buffer).toString('ascii')).map((l) => l.payload)).toEqual(['A-1']);
  });

  it('a zone with nothing to print: empty, or only retired bins — 404 no-bins-to-print', async () => {
    for (const zoneId of [zoneEmpty, zoneRetiredOnly]) {
      expect(await refusal(print({ zoneId, format: 'pdf' }), 404)).toMatchObject({ code: 'no-bins-to-print' });
    }
  });

  it('bad requests: both or neither of binIds/zoneId, size with a4, a4 with zpl, > 1000 or duplicate or malformed ids — 400', async () => {
    const bad: Record<string, unknown>[] = [
      { binIds: ids('A-1'), zoneId: zoneA, format: 'zpl' },
      { format: 'zpl' },
      { zoneId: zoneA, format: 'pdf', layout: 'a4', size: '4x2' },
      { zoneId: zoneA, format: 'zpl', layout: 'a4' },
      { binIds: Array.from({ length: 1001 }, () => uuidv7()), format: 'zpl' },
      { binIds: [bins.get('A-1')!, bins.get('A-1')!], format: 'zpl' },
      { binIds: ['not-a-uuid'], format: 'zpl' },
      { binIds: [], format: 'zpl' },
      { zoneId: zoneA, format: 'png' },
      { zoneId: zoneA, format: 'zpl', size: '6x4' },
      { zoneId: zoneA, format: 'zpl', copies: 2 },
    ];
    for (const body of bad) {
      const problem = await refusal(print(body), 400);
      expect({ body: Object.keys(body), code: problem.code }).toEqual({ body: Object.keys(body), code: 'validation-failed' });
    }
    expect(await refusal(print({ zoneId: zoneA, format: 'zpl' }, ownerToken, 'not-a-uuid'), 400)).toMatchObject({ code: 'validation-failed' });
  });

  it('story 2-10b (decision 10): dedicated-client codes come from one by-ids read — a client beyond the 500-row list prints; an unresolvable client id prints no client line, never a 404', async () => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    try {
      // 500 clients that sort before the dedicated one (the old list read stopped at 500, by code).
      await sql`insert into clients (id, tenant_id, code, name)
        select gen_random_uuid(), ${tenantId}::uuid, 'AAA' || lpad(g::text, 4, '0'), 'Filler ' || g from generate_series(1, 500) g`;
      const beyond = (
        await http().post(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code: 'ZZBEYOND', name: 'Beyond the cap' }).expect(201)
      ).body.client.id as string;
      const binId = await createBin('D-500', zoneA, { dedicatedClientId: beyond });
      const res = await print({ binIds: [binId], format: 'zpl' }).expect(200);
      expect((res.body as Buffer).toString('ascii')).toContain('^FDCLIENT ZZBEYOND^FS');
      // A dedicated id that names no client row (written past the commands): the label prints without a client line.
      const orphan = await createBin('D-ORPHAN');
      await sql`update bins set dedicated_client_id = ${uuidv7()} where id = ${orphan}`;
      const orphaned = (await print({ binIds: [orphan], format: 'zpl' }).expect(200)).body as Buffer;
      expect(parseZplLabels(orphaned.toString('ascii')).map((l) => l.payload)).toEqual(['D-ORPHAN']);
      expect(orphaned.toString('ascii')).not.toContain('CLIENT');
    } finally {
      await sql.end();
    }
  });

  it('access: owner, ops manager and operator print; the accountant gets 403 role-denied; a portal token is fenced', async () => {
    for (const role of ['ops_manager', 'operator']) {
      const token = await invite(role);
      await print({ binIds: ids('A-1'), format: 'zpl' }, token).expect(200);
    }
    const accountant = await invite('accountant');
    expect(await refusal(print({ binIds: ids('A-1'), format: 'zpl' }, accountant), 403)).toMatchObject({ code: 'role-denied' });
    // Authority precedes every other refusal: the accountant learns nothing about an unknown warehouse,
    // a malformed warehouse id or a body breaking the cross-field rules.
    expect(await refusal(print({ binIds: ids('A-1'), format: 'zpl' }, accountant, uuidv7()), 403)).toMatchObject({ code: 'role-denied' });
    expect(await refusal(print({ binIds: ids('A-1'), format: 'zpl' }, accountant, 'not-a-uuid'), 403)).toMatchObject({ code: 'role-denied' });
    for (const body of [
      { binIds: ids('A-1'), zoneId: zoneA, format: 'zpl' },
      { format: 'zpl' },
      { zoneId: zoneA, format: 'zpl', layout: 'a4' },
      { zoneId: zoneA, format: 'pdf', layout: 'a4', size: '2x1' },
    ]) {
      expect(await refusal(print(body, accountant), 403)).toMatchObject({ code: 'role-denied' });
    }
    const portalToken = signTenantSession(
      { tenantId, userId: ownerUserId, sessionId: uuidv7(), kind: 'portal', clientId: uuidv7() },
      process.env.JWT_SECRET!,
    );
    const fenced = await refusal(print({ binIds: ids('A-1'), format: 'zpl' }, portalToken), 403);
    expect(fenced).toMatchObject({ code: 'role-denied', detail: 'This is an operator surface.' });
    await refusal(print({ binIds: ids('A-1'), format: 'zpl' }, 'not-a-token'), 401);
  });

  it('route order: the literal labels route is declared before the bins/:binId routes and answers itself', async () => {
    const methods = Object.getOwnPropertyNames(TenancyController.prototype);
    const at = (name: string): number => {
      const i = methods.indexOf(name);
      expect({ name, found: i >= 0 }).toEqual({ name, found: true });
      return i;
    };
    for (const later of ['setBinBlocked', 'mergeBin', 'retireBin']) {
      expect(at('printBinLabels')).toBeLessThan(at(later));
    }
    // `labels` is not taken for a bin id: no 400 "binId must be a uuid", no merge/retire 404.
    await print({ binIds: ids('A-1'), format: 'zpl' }).expect(200);
  });

  it('the route is in the served and the committed OpenAPI document, binary 200s and its error arms', async () => {
    const served = (await http().get('/api/v1/openapi.json').expect(200)).body as { paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown> }> }>> };
    const committed = JSON.parse(readFileSync(join(__dirname, '..', 'openapi', 'openapi.json'), 'utf8')) as typeof served;
    for (const doc of [served, committed]) {
      const op = doc.paths['/tenants/{tenantId}/warehouses/{warehouseId}/bins/labels']?.post;
      expect(op).toBeDefined();
      expect(Object.keys(op!.responses['200']!.content!).sort()).toEqual(['application/pdf', 'text/plain']);
      expect(Object.keys(op!.responses).sort()).toEqual(['200', '400', '401', '403', '404', '422']);
    }
  });

  it('the filename: IST date, the warehouse code folded to [A-Za-z0-9._-]', () => {
    // 23:59:59.999 IST on 21 Oct, then midnight IST.
    expect(binLabelsFilename('BLR-1', 'zpl', '2026-10-21T18:29:59.999Z')).toBe('bin-labels-BLR-1-20261021.zpl');
    expect(binLabelsFilename('BLR-1', 'pdf', '2026-10-21T18:30:00.000Z')).toBe('bin-labels-BLR-1-20261022.pdf');
    expect(binLabelsFilename('BL R/1"é', 'pdf', '2026-10-21T18:30:00.000Z')).toBe('bin-labels-BL-R-1---20261022.pdf');
  });

  it('1000 labels as an A4 PDF in under 15 s (zone print at the bound); 1001 is 422 too-many-labels', async () => {
    const big = await createWarehouse(ownerToken, tenantId, `BG-${ulid().slice(20, 24)}`);
    const zone = await createZone('BIG', big);
    for (const [aisleFrom, aisleTo] of [['A', 'E'], ['F', 'J']]) {
      await http()
        .post(`${API}/${tenantId}/warehouses/${big}/zones/${zone}/bins/grid`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ aisleFrom, aisleTo, baysPerAisle: 10, levelsPerBay: 10, capacity: 10, type: 'shelf' })
        .expect(201);
    }
    const started = Date.now();
    const res = await print({ zoneId: zone, format: 'pdf', layout: 'a4' }, ownerToken, big).expect(200);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(15_000);
    const pages = await readPdfLabels(res.body as Buffer);
    expect(pages).toHaveLength(42); // 41 full sheets + 16
    expect(pages.flatMap((p) => p.payloads)).toHaveLength(1000);
    expect(pages[0]!.payloads[0]).toBe('A-01-01');

    await createBin('ZZ-EXTRA', zone, {}, big);
    const body = await refusal(print({ zoneId: zone, format: 'zpl' }, ownerToken, big), 422);
    expect(body).toMatchObject({ code: 'too-many-labels', count: 1001 });
    expect(body.detail).toContain('1001');
  });
});
