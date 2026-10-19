import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { ReceivingFacade } from '../src/modules/inbound/receiving.facade';
import { PARTNER_LINK_ROLES, PARTNER_ROLES, PARTNER_STATUSES } from '../src/shared/db/schema';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow, noOpIdempotencyKey } from './support/audit-guard';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';

// Story 1-3 — the business partner master: partners (one GST registration,
// roles vendor / consignee / transporter), their client links, the default
// vendor on the link, the PO vendor guard and the frozen vendor snapshot.
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
const G1 = '27ABCDE1234F1Z5'; // PAN ABCDE1234F, Maharashtra
const G2 = '27PQRST5678K1Z2'; // PAN PQRST5678K
const G1_KA = '29ABCDE1234F1Z3'; // the SAME PAN, registered in Karnataka — another partner (decision 5)

interface Link {
  id: string;
  clientId: string;
  role: string;
  active: boolean;
  isDefault: boolean;
  clientCode: string | null;
}

interface Partner {
  id: string;
  code: string;
  name: string;
  legalName: string | null;
  gstin: string | null;
  pan: string | null;
  roles: string[];
  status: string;
  inactiveReason: string | null;
  registeredAddress: { line1: string; line2: string | null; city: string; stateCode: string; pincode: string } | null;
  links: Link[];
}

describe('story 1-3: the business partner master (e2e)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;

  let tenantId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let warehouseId: string;
  let selfClient: string;
  let clientC: string;
  let skuSelf: string;
  let skuC: string;

  const http = () => request(app.getHttpServer());
  const asOwner = (method: 'get' | 'post' | 'patch', path: string, key: string = ulid()): SupertestTest =>
    http()[method](`${API}/${tenantId}${path}`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, key);

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('business_partners');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2 });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Partner Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerUserId = registered.body.owner.id as string;
    ownerToken = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;
    warehouseId = (
      await asOwner('post', '/warehouses').send({ origin: testAddress(), code: 'BP-W1', name: 'Partner Depot' }).expect(201)
    ).body.id as string;
    const clients = await asOwner('get', '/clients').expect(200);
    selfClient = (clients.body.items as { id: string; systemOwned: boolean }[]).find((c) => c.systemOwned)!.id;
    clientC = (await asOwner('post', '/clients').send({ code: 'BRAND-C', name: 'Brand C' }).expect(201)).body.client.id as string;
    skuSelf = await importSku('BP-SELF', selfClient);
    skuC = await importSku('BP-C', clientC);
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

  async function importSku(code: string, clientId: string): Promise<string> {
    const csv = ['sku_code,name,uom,gst_rate,hsn,barcode', `${code},Item ${code},pcs,1800,,${code}-BC`].join('\n');
    await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', clientId)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const rows = (await sql`select id from skus where tenant_id = ${tenantId} and code = ${code} and client_id = ${clientId}`) as unknown as {
      id: string;
    }[];
    return rows[0]!.id;
  }

  async function createMember(role: 'ops_manager' | 'operator'): Promise<string> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await asOwner('post', '/users').send({ email, role }).expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    return (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;
  }

  async function createPartner(body: Record<string, unknown>, key: string = ulid()): Promise<Partner> {
    return (await asOwner('post', '/partners', key).send(body).expect(201)).body.partner as Partner;
  }

  async function link(partnerId: string, body: Record<string, unknown>, key: string = ulid()): Promise<Partner> {
    return (await asOwner('post', `/partners/${partnerId}/links`, key).send(body).expect(201)).body.partner as Partner;
  }

  const linkOf = (partner: Partner, clientId: string, role = 'vendor'): Link =>
    partner.links.find((row) => row.clientId === clientId && row.role === role)!;

  function createPo(vendorId: string, skuId: string, key: string = ulid()): SupertestTest {
    return asOwner('post', '/inbound/purchase-orders', key).send({
      warehouseId,
      vendorId,
      code: `PO-${ulid().slice(12, 22)}`,
      lines: [{ skuId, orderedQty: 5, unitCostPaise: 1000 }],
    });
  }

  function handle(): postgres.Sql<Record<string, unknown>> {
    return postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
  }

  /** Polls until `min` requests are parked on a lock whose chain leads back to the holder. */
  async function waitParked(table: string, holderPid: number, min: number): Promise<void> {
    const probe = handle();
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const waiting = (await probe`
          select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
          where a.wait_event_type = 'Lock' and a.state = 'active' and a.query ilike ${`%"${table}"%`}
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
      throw new Error(`fewer than ${min} request(s) parked on the ${table} row`);
    } finally {
      await probe.end();
    }
  }

  /** Two same-key requests fired while a raw holder has the partner row FOR UPDATE; released once both are parked. */
  async function raceTwice(partnerId: string, send: () => SupertestTest): Promise<[request.Response, request.Response]> {
    const holder = handle();
    let first: Promise<request.Response> | undefined;
    let second: Promise<request.Response> | undefined;
    try {
      await holder.begin(async (tx) => {
        const locked = (await tx`
          select pg_backend_pid() as pid from business_partners where tenant_id = ${tenantId} and id = ${partnerId} for update
        `) as unknown as { pid: number }[];
        first = (async () => send())();
        second = (async () => send())();
        await waitParked('business_partners', locked[0]!.pid, 2);
      });
      return await Promise.all([first!, second!]);
    } finally {
      await Promise.allSettled([first, second]);
      await holder.end();
    }
  }

  async function auditCount(key: string): Promise<number> {
    const rows = (await sql`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and reference = ${key}`) as unknown as {
      n: number;
    }[];
    return Number(rows[0]!.n);
  }

  async function keyCount(key: string): Promise<number> {
    const rows = (await sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as {
      n: number;
    }[];
    return Number(rows[0]!.n);
  }

  // ── create ─────────────────────────────────────────────────────────────────

  it('create a vendor: 201, PAN derived from the GSTIN, one `vendor.created` outbox event, audited; a same-key resend replays', async () => {
    const key = ulid();
    const body = {
      code: 'P-1',
      name: 'Deccan Packaging',
      legalName: 'Deccan Packaging Private Limited',
      roles: ['vendor'],
      gstin: G1.toLowerCase(),
      registeredAddress: { line1: 'Plot 12, MIDC', city: 'Pune', stateCode: '27', pincode: '411001' },
      contactName: 'Asha Rao',
      contactEmail: 'Asha@Example.com',
    };
    const created = await createPartner(body, key);
    expect(created).toMatchObject({
      code: 'P-1',
      gstin: G1,
      pan: 'ABCDE1234F',
      roles: ['vendor'],
      status: 'active',
      inactiveReason: null,
      links: [],
      registeredAddress: { line1: 'Plot 12, MIDC', line2: null, city: 'Pune', stateCode: '27', pincode: '411001' },
    });
    const replay = await asOwner('post', '/partners', key).send(body).expect(201);
    expect(replay.body.partner).toEqual(created);
    const events = (await sql`
      select payload from outbox_messages where tenant_id = ${tenantId} and type = 'vendor.created'
      and payload->'vendor'->>'id' = ${created.id}`) as unknown as { payload: { vendor: { code: string } } }[];
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.vendor.code).toBe('P-1');
    await expectAuditRow({ tenantId, key, action: 'partner.created', targetType: 'partner', targetId: created.id, actorUserId: ownerUserId });
  });

  it('create refusals: a taken code 409 partner-code-taken; a taken GSTIN 409 naming the holder; PAN/GSTIN and GSTIN/state mismatches 400; a bad field 400 naming it', async () => {
    const takenCode = await asOwner('post', '/partners').send({ code: 'P-1', name: 'Another', roles: ['vendor'] }).expect(409);
    expect(takenCode.body).toMatchObject({ code: 'partner-code-taken' });
    const takenGstin = await asOwner('post', '/partners').send({ code: 'P-DUP', name: 'Dup', roles: ['vendor'], gstin: G1 }).expect(409);
    expect(takenGstin.body).toMatchObject({ code: 'partner-gstin-taken' });
    expect(takenGstin.body.detail).toContain('"P-1"');
    const pan = await asOwner('post', '/partners').send({ code: 'P-PAN', name: 'Pan', roles: ['vendor'], gstin: G2, pan: 'ABCDE1234F' }).expect(400);
    expect(pan.body).toMatchObject({ code: 'pan-gstin-mismatch' });
    const state = await asOwner('post', '/partners')
      .send({ code: 'P-ST', name: 'State', roles: ['vendor'], gstin: G2, registeredAddress: { line1: 'x', city: 'Bengaluru', stateCode: '29', pincode: '560001' } })
      .expect(400);
    expect(state.body).toMatchObject({ code: 'gstin-state-mismatch' });
    const pincode = await asOwner('post', '/partners')
      .send({ code: 'P-PIN', name: 'Pin', roles: ['vendor'], dispatchAddress: { line1: 'x', city: 'Pune', stateCode: '27', pincode: '4110' } })
      .expect(400);
    expect(pincode.body).toMatchObject({ code: 'validation-failed' });
    expect(pincode.body.detail).toContain('dispatchAddress.pincode');
    const badPan = await asOwner('post', '/partners').send({ code: 'P-BP', name: 'Bad pan', roles: ['vendor'], pan: 'ABCDE12345' }).expect(400);
    expect(badPan.body.detail).toContain('pan');
    const noRole = await asOwner('post', '/partners').send({ code: 'P-NR', name: 'No role', roles: [] }).expect(400);
    expect(noRole.body).toMatchObject({ code: 'validation-failed' });
    // Decision 5 — one partner is one GST registration: the same PAN in another state is a second partner.
    const ka = await createPartner({ code: 'P-1-KA', name: 'Deccan Packaging (KA)', roles: ['vendor'], gstin: G1_KA });
    expect(ka.pan).toBe('ABCDE1234F');
  });

  it('create authority: an operator is 403 role-denied; a foreign tenant 403 permission-denied; no token 401', async () => {
    const operatorToken = await createMember('operator');
    const denied = await http()
      .post(`${API}/${tenantId}/partners`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'P-OP', name: 'Op', roles: ['vendor'] })
      .expect(403);
    expect(denied.body).toMatchObject({ code: 'role-denied' });
    // The read is open to the operator (the web shows the tab read-only).
    await http().get(`${API}/${tenantId}/partners`).set('Authorization', `Bearer ${operatorToken}`).expect(200);
    await http()
      .post(`${API}/${uuidv7()}/partners`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'P-X', name: 'X', roles: ['vendor'] })
      .expect(403)
      .then((res) => expect(res.body).toMatchObject({ code: 'permission-denied' }));
    await http().post(`${API}/${tenantId}/partners`).send({ code: 'P-X', name: 'X', roles: ['vendor'] }).expect(401);
    // The Story 3.1 routes are gone — no alias.
    await http().get(`${API}/${tenantId}/vendors`).set('Authorization', `Bearer ${ownerToken}`).expect(404);
  });

  it('a consignee created without the vendor role emits no `vendor.created`; adding the role later emits none either', async () => {
    const consignee = await createPartner({ code: 'C-1', name: 'Metro Retail', roles: ['consignee'] });
    await asOwner('patch', `/partners/${consignee.id}`).send({ roles: ['vendor', 'consignee'] }).expect(200);
    const events = (await sql`
      select count(*)::int as n from outbox_messages where tenant_id = ${tenantId} and type = 'vendor.created'
      and payload->'vendor'->>'id' = ${consignee.id}`) as unknown as { n: number }[];
    expect(Number(events[0]!.n)).toBe(0);
  });

  // ── edit ───────────────────────────────────────────────────────────────────

  it('edit: a GSTIN colliding with another partner is 409 naming it and changes nothing; clearing the GSTIN keeps the PAN; an unchanged edit stores the key and audits nothing', async () => {
    const p2 = await createPartner({ code: 'P-2', name: 'Konkan Foods', roles: ['vendor'] });
    const collide = await asOwner('patch', `/partners/${p2.id}`).send({ gstin: G1 }).expect(409);
    expect(collide.body).toMatchObject({ code: 'partner-gstin-taken' });
    expect(collide.body.detail).toContain('"P-1"');
    const stored = (await sql`select gstin from business_partners where id = ${p2.id}`) as unknown as { gstin: string | null }[];
    expect(stored[0]!.gstin).toBeNull();

    const setKey = ulid();
    const set = (await asOwner('patch', `/partners/${p2.id}`, setKey).send({ gstin: G2, legalName: 'Konkan Foods LLP' }).expect(200)).body
      .partner as Partner;
    expect(set).toMatchObject({ gstin: G2, pan: 'PQRST5678K', legalName: 'Konkan Foods LLP' });
    await expectAuditRow({ tenantId, key: setKey, action: 'partner.updated', targetType: 'partner', targetId: p2.id, actorUserId: ownerUserId });

    const cleared = (await asOwner('patch', `/partners/${p2.id}`).send({ gstin: null, legalName: null }).expect(200)).body.partner as Partner;
    expect(cleared).toMatchObject({ gstin: null, pan: 'PQRST5678K', legalName: null });

    const unchangedKey = noOpIdempotencyKey(tenantId, ulid(), 'partners.update:unchanged');
    const unchanged = await asOwner('patch', `/partners/${p2.id}`, unchangedKey).send({ name: 'Konkan Foods' }).expect(200);
    expect(unchanged.body.partner).toMatchObject({ name: 'Konkan Foods' });
    expect(await auditCount(unchangedKey)).toBe(0);
    expect(await keyCount(unchangedKey)).toBe(1);

    // A PATCH runs every rule on the MERGED row: a PAN differing from the stored GSTIN's.
    await asOwner('patch', `/partners/${p2.id}`).send({ gstin: G2 }).expect(200);
    const mismatch = await asOwner('patch', `/partners/${p2.id}`).send({ pan: 'ABCDE1234F' }).expect(400);
    expect(mismatch.body).toMatchObject({ code: 'pan-gstin-mismatch' });
    await asOwner('patch', `/partners/${uuidv7()}`).send({ name: 'x' }).expect(404);
  });

  // ── links ──────────────────────────────────────────────────────────────────

  it('link: a vendor linked to client C with its own code; the same triple again is 409 link-exists naming the link; a transporter or a role the partner lacks is 400 link-role-invalid; a taken client code 409', async () => {
    const p = await createPartner({ code: 'P-L', name: 'Link Vendor', roles: ['vendor'] });
    const key = ulid();
    const linked = await link(p.id, { clientId: clientC, role: 'vendor', clientCode: '  SUP-9 ' }, key);
    const created = linkOf(linked, clientC);
    expect(created).toMatchObject({ active: true, isDefault: false, clientCode: 'SUP-9' });
    await expectAuditRow({ tenantId, key, action: 'partner.linked', targetType: 'partner_link', targetId: created.id, actorUserId: ownerUserId });

    const again = await asOwner('post', `/partners/${p.id}/links`).send({ clientId: clientC, role: 'vendor' }).expect(409);
    expect(again.body).toMatchObject({ code: 'link-exists' });
    expect(again.body.detail).toContain(created.id);
    const lacks = await asOwner('post', `/partners/${p.id}/links`).send({ clientId: clientC, role: 'consignee' }).expect(400);
    expect(lacks.body).toMatchObject({ code: 'link-role-invalid' });
    const transporter = await createPartner({ code: 'T-1', name: 'Fast Freight', roles: ['transporter'] });
    const shared = await asOwner('post', `/partners/${transporter.id}/links`).send({ clientId: clientC, role: 'transporter' }).expect(400);
    expect(shared.body).toMatchObject({ code: 'link-role-invalid' });

    const other = await createPartner({ code: 'P-L2', name: 'Other Vendor', roles: ['vendor'] });
    const taken = await asOwner('post', `/partners/${other.id}/links`).send({ clientId: clientC, role: 'vendor', clientCode: 'SUP-9' }).expect(409);
    expect(taken.body).toMatchObject({ code: 'link-client-code-taken' });
    // The self client links like any other (the web shows it as "Your company").
    expect(linkOf(await link(other.id, { clientId: selfClient, role: 'vendor' }), selfClient).active).toBe(true);
  });

  it('link refusals: an inactive partner 409 partner-inactive; a departed client 409 client-departed; an unknown client 404', async () => {
    const p = await createPartner({ code: 'P-IN', name: 'Inactive Vendor', roles: ['vendor'] });
    await asOwner('patch', `/partners/${p.id}/status`).send({ status: 'inactive', reason: 'stopped trading' }).expect(200);
    const inactive = await asOwner('post', `/partners/${p.id}/links`).send({ clientId: clientC, role: 'vendor' }).expect(409);
    expect(inactive.body).toMatchObject({ code: 'partner-inactive' });

    const gone = (await asOwner('post', '/clients').send({ code: 'GONE', name: 'Gone Brand' }).expect(201)).body.client.id as string;
    await asOwner('patch', `/clients/${gone}/status`).send({ status: 'departed' }).expect(200);
    const active = await createPartner({ code: 'P-DEP', name: 'Departed-client Vendor', roles: ['vendor'] });
    const departed = await asOwner('post', `/partners/${active.id}/links`).send({ clientId: gone, role: 'vendor' }).expect(409);
    expect(departed.body).toMatchObject({ code: 'client-departed' });
    await asOwner('post', `/partners/${active.id}/links`).send({ clientId: uuidv7(), role: 'vendor' }).expect(404);
  });

  it('link edit: switch off (audited link_deactivated), back on (link_reactivated), a code change (link_updated); an unchanged edit stores the key', async () => {
    const p = await createPartner({ code: 'P-LE', name: 'Link Edit Vendor', roles: ['vendor'] });
    const linkId = linkOf(await link(p.id, { clientId: clientC, role: 'vendor' }), clientC).id;
    const offKey = ulid();
    const off = (await asOwner('patch', `/partners/${p.id}/links/${linkId}`, offKey).send({ active: false }).expect(200)).body.partner as Partner;
    expect(linkOf(off, clientC).active).toBe(false);
    await expectAuditRow({ tenantId, key: offKey, action: 'partner.link_deactivated', targetType: 'partner_link', targetId: linkId, actorUserId: ownerUserId });
    const onKey = ulid();
    await asOwner('patch', `/partners/${p.id}/links/${linkId}`, onKey).send({ active: true }).expect(200);
    await expectAuditRow({ tenantId, key: onKey, action: 'partner.link_reactivated', targetType: 'partner_link', targetId: linkId, actorUserId: ownerUserId });
    const codeKey = ulid();
    const coded = (await asOwner('patch', `/partners/${p.id}/links/${linkId}`, codeKey).send({ clientCode: 'LE-1' }).expect(200)).body
      .partner as Partner;
    expect(linkOf(coded, clientC).clientCode).toBe('LE-1');
    await expectAuditRow({ tenantId, key: codeKey, action: 'partner.link_updated', targetType: 'partner_link', targetId: linkId, actorUserId: ownerUserId });
    const sameKey = noOpIdempotencyKey(tenantId, ulid(), 'partners.linkUpdate:unchanged');
    await asOwner('patch', `/partners/${p.id}/links/${linkId}`, sameKey).send({ clientCode: 'LE-1', active: true }).expect(200);
    expect(await auditCount(sameKey)).toBe(0);
    await asOwner('patch', `/partners/${p.id}/links/${uuidv7()}`).send({ active: false }).expect(404);
  });

  it('role removal: refused 409 partner-role-in-use while an active link carries the role; allowed once the link is off', async () => {
    const p = await createPartner({ code: 'P-RR', name: 'Role Vendor', roles: ['vendor', 'consignee'] });
    const linked = await link(p.id, { clientId: clientC, role: 'consignee' });
    const inUse = await asOwner('patch', `/partners/${p.id}`).send({ roles: ['vendor'] }).expect(409);
    expect(inUse.body).toMatchObject({ code: 'partner-role-in-use' });
    await asOwner('patch', `/partners/${p.id}/links/${linkOf(linked, clientC, 'consignee').id}`).send({ active: false }).expect(200);
    const narrowed = (await asOwner('patch', `/partners/${p.id}`).send({ roles: ['vendor'] }).expect(200)).body.partner as Partner;
    expect(narrowed.roles).toEqual(['vendor']);
    // The switched-off consignee link cannot come back while the partner lacks the role.
    const back = await asOwner('patch', `/partners/${p.id}/links/${linkOf(linked, clientC, 'consignee').id}`).send({ active: true }).expect(400);
    expect(back.body).toMatchObject({ code: 'link-role-invalid' });
  });

  // ── the PO guard and the snapshot ─────────────────────────────────────────

  it('PO vendor guard: unlinked 409 vendor-not-linked naming the client; a consignee 409 partner-not-vendor; inactive 409 vendor-inactive; with an unknown SKU too, the SKU 404 wins', async () => {
    const v = await createPartner({ code: 'P-G', name: 'Guard Vendor', roles: ['vendor'] });
    await link(v.id, { clientId: selfClient, role: 'vendor' });
    const unlinked = await createPo(v.id, skuC).expect(409);
    expect(unlinked.body).toMatchObject({ code: 'vendor-not-linked' });
    expect(unlinked.body.detail).toContain('BRAND-C');
    const consignee = await createPartner({ code: 'C-G', name: 'Guard Consignee', roles: ['consignee'] });
    expect((await createPo(consignee.id, skuSelf).expect(409)).body).toMatchObject({ code: 'partner-not-vendor' });
    const unknownBoth = await asOwner('post', '/inbound/purchase-orders')
      .send({ warehouseId, vendorId: uuidv7(), code: `PO-${ulid().slice(12, 22)}`, lines: [{ skuId: uuidv7(), orderedQty: 1, unitCostPaise: 100 }] })
      .expect(404);
    expect(unknownBoth.body.detail).toContain('SKU');
    expect((await createPo(uuidv7(), skuSelf).expect(404)).body.detail).toContain('vendor');
    await asOwner('patch', `/partners/${v.id}/status`).send({ status: 'inactive' }).expect(200);
    expect((await createPo(v.id, skuSelf).expect(409)).body).toMatchObject({ code: 'vendor-inactive' });
    await asOwner('patch', `/partners/${v.id}/status`).send({ status: 'active' }).expect(200);
    await createPo(v.id, skuSelf).expect(201);
  });

  it('PO snapshot: a full v1 vendor snapshot on create, read and list; a later partner edit never rewrites it; a close successor copies it even after the vendor is deactivated', async () => {
    const v = await createPartner({
      code: 'P-S',
      name: 'Snapshot Vendor',
      legalName: 'Snapshot Vendor Pvt Ltd',
      roles: ['vendor'],
      gstin: '27SNAPS1234Q1Z9',
      registeredAddress: { line1: '1 Snap Road', city: 'Mumbai', stateCode: '27', pincode: '400001' },
    });
    await link(v.id, { clientId: selfClient, role: 'vendor' });
    const po = (await createPo(v.id, skuSelf).expect(201)).body.purchaseOrder as {
      id: string;
      lines: { id: string }[];
      vendorSnapshot: Record<string, unknown>;
    };
    const expected = {
      v: 1,
      code: 'P-S',
      name: 'Snapshot Vendor',
      legalName: 'Snapshot Vendor Pvt Ltd',
      gstin: '27SNAPS1234Q1Z9',
      stateCode: '27',
      registeredAddress: { line1: '1 Snap Road', line2: null, city: 'Mumbai', stateCode: '27', pincode: '400001' },
      dispatchAddress: null,
    };
    expect(po.vendorSnapshot).toEqual(expected);
    await asOwner('patch', `/partners/${v.id}`).send({ name: 'Renamed Vendor', legalName: null }).expect(200);
    const read = await asOwner('get', `/inbound/purchase-orders/${po.id}`).expect(200);
    expect(read.body.purchaseOrder.vendorSnapshot).toEqual(expected);
    const list = await asOwner('get', `/warehouses/${warehouseId}/inbound/purchase-orders?limit=200`).expect(200);
    expect((list.body.items as { id: string; vendorSnapshot: unknown }[]).find((row) => row.id === po.id)!.vendorSnapshot).toEqual(expected);
    // Decision 1 — open POs keep working; a close successor carries the vendor and snapshot without the guard.
    await asOwner('patch', `/partners/${v.id}/status`).send({ status: 'inactive', reason: 'blocked' }).expect(200);
    const closed = await asOwner('post', `/inbound/purchase-orders/${po.id}/close`)
      .send({ lines: [{ lineId: po.lines[0]!.id, disposition: 'carried' }] })
      .expect(200);
    expect(closed.body.successor.vendorId).toBe(v.id);
    expect(closed.body.successor.vendorSnapshot).toEqual(expected);
  });

  it('the device snapshot carries each open PO\'s vendor name (the frozen one)', async () => {
    const v = await createPartner({ code: 'P-DEV', name: 'Device Vendor', roles: ['vendor'] });
    await link(v.id, { clientId: selfClient, role: 'vendor' });
    const po = (await createPo(v.id, skuSelf).expect(201)).body.purchaseOrder as { id: string };
    await asOwner('patch', `/partners/${v.id}`).send({ name: 'Device Vendor Renamed' }).expect(200);
    // The facade read the device route serves (`GET devices/catalog-snapshot`, device session).
    const snapshot = await app.get(ReceivingFacade).getCatalogSnapshot(tenantId, warehouseId);
    const row = snapshot.openPurchaseOrders.find((entry) => entry.id === po.id)!;
    expect(row.vendorName).toBe('Device Vendor');
  });

  // ── status and the default vendor ─────────────────────────────────────────

  it('default vendor: one per client — setting another clears the first; deactivating the partner clears it and reactivating brings nothing back; status no-op stores the key', async () => {
    const a = await createPartner({ code: 'P-DA', name: 'Default A', roles: ['vendor'] });
    const b = await createPartner({ code: 'P-DB', name: 'Default B', roles: ['vendor'] });
    const aLink = linkOf(await link(a.id, { clientId: clientC, role: 'vendor', isDefault: true }), clientC);
    expect(aLink.isDefault).toBe(true);
    const bLink = linkOf(await link(b.id, { clientId: clientC, role: 'vendor' }), clientC);
    await asOwner('patch', `/partners/${b.id}/links/${bLink.id}`).send({ isDefault: true }).expect(200);
    const defaults = (await sql`
      select partner_id from partner_client_links where tenant_id = ${tenantId} and client_id = ${clientC} and is_default`) as unknown as {
      partner_id: string;
    }[];
    expect(defaults.map((row) => row.partner_id)).toEqual([b.id]);

    const offKey = ulid();
    const off = (await asOwner('patch', `/partners/${b.id}/status`, offKey).send({ status: 'inactive', reason: 'quality' }).expect(200)).body
      .partner as Partner;
    expect(off).toMatchObject({ status: 'inactive', inactiveReason: 'quality' });
    expect(linkOf(off, clientC).isDefault).toBe(false);
    await expectAuditRow({ tenantId, key: offKey, action: 'partner.deactivated', targetType: 'partner', targetId: b.id, actorUserId: ownerUserId });
    const sameKey = noOpIdempotencyKey(tenantId, ulid(), 'partners.status:unchanged');
    await asOwner('patch', `/partners/${b.id}/status`, sameKey).send({ status: 'inactive', reason: 'quality' }).expect(200);
    expect(await auditCount(sameKey)).toBe(0);
    const onKey = ulid();
    const on = (await asOwner('patch', `/partners/${b.id}/status`, onKey).send({ status: 'active' }).expect(200)).body.partner as Partner;
    expect(on).toMatchObject({ status: 'active', inactiveReason: null });
    expect(linkOf(on, clientC).isDefault).toBe(false);
    await expectAuditRow({ tenantId, key: onKey, action: 'partner.reactivated', targetType: 'partner', targetId: b.id, actorUserId: ownerUserId });
    const reason = await asOwner('patch', `/partners/${b.id}/status`).send({ status: 'active', reason: 'x' }).expect(400);
    expect(reason.body).toMatchObject({ code: 'validation-failed' });

    // A default only on an active vendor link; switching a link off clears its default.
    const consigneeLink = await asOwner('post', `/partners/${a.id}/links`).send({ clientId: selfClient, role: 'consignee', isDefault: true }).expect(400);
    expect(consigneeLink.body).toMatchObject({ code: 'validation-failed' });
    await asOwner('patch', `/partners/${a.id}/links/${aLink.id}`).send({ isDefault: true }).expect(200);
    const switchedOff = (await asOwner('patch', `/partners/${a.id}/links/${aLink.id}`).send({ active: false }).expect(200)).body.partner as Partner;
    expect(linkOf(switchedOff, clientC)).toMatchObject({ active: false, isDefault: false });
    await asOwner('patch', `/partners/${a.id}/links/${aLink.id}`).send({ isDefault: true }).expect(400);
  });

  it('code review — a new GSTIN with no PAN re-derives the PAN when the stored one was the old GSTIN\'s; naming the old PAN still refuses', async () => {
    const p = await createPartner({ code: 'P-RD', name: 'Rederive Vendor', roles: ['vendor'], gstin: '27LMNOP2345R1Z1' });
    expect(p.pan).toBe('LMNOP2345R');
    const moved = (await asOwner('patch', `/partners/${p.id}`).send({ gstin: '27UVWXY6789S1Z4' }).expect(200)).body.partner as Partner;
    expect(moved).toMatchObject({ gstin: '27UVWXY6789S1Z4', pan: 'UVWXY6789S' });
    const named = await asOwner('patch', `/partners/${p.id}`).send({ gstin: '27LMNOP2345R1Z1', pan: 'UVWXY6789S' }).expect(400);
    expect(named.body).toMatchObject({ code: 'pan-gstin-mismatch' });
  });

  it('code review — re-deactivating with no reason keeps the stored reason (a no-op that stores the key)', async () => {
    const p = await createPartner({ code: 'P-RR2', name: 'Reason Vendor', roles: ['vendor'] });
    await asOwner('patch', `/partners/${p.id}/status`).send({ status: 'inactive', reason: 'late deliveries' }).expect(200);
    const key = noOpIdempotencyKey(tenantId, ulid(), 'partners.status:unchanged');
    const again = (await asOwner('patch', `/partners/${p.id}/status`, key).send({ status: 'inactive' }).expect(200)).body.partner as Partner;
    expect(again.inactiveReason).toBe('late deliveries');
    expect(await auditCount(key)).toBe(0);
  });

  it('code review — a departed client\'s link: setting the default is 409 client-departed; active:true on an already-active link is the no-op', async () => {
    const gone = (await asOwner('post', '/clients').send({ code: 'GONE-2', name: 'Gone Two' }).expect(201)).body.client.id as string;
    const p = await createPartner({ code: 'P-GD', name: 'Gone-client Vendor', roles: ['vendor'] });
    const linkId = linkOf(await link(p.id, { clientId: gone, role: 'vendor' }), gone).id;
    await asOwner('patch', `/clients/${gone}/status`).send({ status: 'departed' }).expect(200);
    const refused = await asOwner('patch', `/partners/${p.id}/links/${linkId}`).send({ isDefault: true }).expect(409);
    expect(refused.body).toMatchObject({ code: 'client-departed' });
    const key = noOpIdempotencyKey(tenantId, ulid(), 'partners.linkUpdate:unchanged');
    const same = (await asOwner('patch', `/partners/${p.id}/links/${linkId}`, key).send({ active: true }).expect(200)).body.partner as Partner;
    expect(linkOf(same, gone)).toMatchObject({ active: true, isDefault: false });
    expect(await auditCount(key)).toBe(0);
  });

  it('code review — a new link created as the default takes over the client\'s default', async () => {
    const client = (await asOwner('post', '/clients').send({ code: 'BRAND-E', name: 'Brand E' }).expect(201)).body.client.id as string;
    const first = await createPartner({ code: 'P-E1', name: 'E one', roles: ['vendor'] });
    const second = await createPartner({ code: 'P-E2', name: 'E two', roles: ['vendor'] });
    await link(first.id, { clientId: client, role: 'vendor', isDefault: true });
    const res = await asOwner('post', `/partners/${second.id}/links`).send({ clientId: client, role: 'vendor', isDefault: true }).expect(201);
    expect(linkOf(res.body.partner as Partner, client).isDefault).toBe(true);
    const old = (await asOwner('get', `/partners?q=P-E1`).expect(200)).body.items[0] as Partner;
    expect(linkOf(old, client).isDefault).toBe(false);
  });

  it('code review — an inactive partner: neither a default nor a reactivation of its link; nothing changes', async () => {
    const p = await createPartner({ code: 'P-IA', name: 'Inactive links', roles: ['vendor'] });
    const linked = await link(p.id, { clientId: clientC, role: 'vendor', clientCode: 'IA-1' });
    const linkId = linkOf(linked, clientC).id;
    await asOwner('patch', `/partners/${p.id}/links/${linkId}`).send({ active: false }).expect(200);
    await asOwner('patch', `/partners/${p.id}/status`).send({ status: 'inactive' }).expect(200);
    const before = (await sql`select active, is_default, updated_at from partner_client_links where id = ${linkId}`) as unknown as Record<string, unknown>[];
    expect((await asOwner('patch', `/partners/${p.id}/links/${linkId}`).send({ active: true }).expect(409)).body).toMatchObject({ code: 'partner-inactive' });
    expect((await asOwner('patch', `/partners/${p.id}/links/${linkId}`).send({ active: true, isDefault: true }).expect(409)).body).toMatchObject({ code: 'partner-inactive' });
    await asOwner('patch', `/partners/${p.id}/status`).send({ status: 'active' }).expect(200);
    await asOwner('patch', `/partners/${p.id}/links/${linkId}`).send({ active: true }).expect(200);
    await asOwner('patch', `/partners/${p.id}/status`).send({ status: 'inactive' }).expect(200);
    const defaultRefused = await asOwner('patch', `/partners/${p.id}/links/${linkId}`).send({ isDefault: true }).expect(409);
    expect(defaultRefused.body).toMatchObject({ code: 'partner-inactive' });
    const after = (await sql`select active, is_default from partner_client_links where id = ${linkId}`) as unknown as Record<string, unknown>[];
    expect(after[0]).toMatchObject({ active: true, is_default: false });
    expect(before[0]).toMatchObject({ active: false, is_default: false });
  });

  it('code review — one partner the default of clients F and G: another vendor taking F\'s default leaves G\'s untouched', async () => {
    const f = (await asOwner('post', '/clients').send({ code: 'BRAND-F', name: 'Brand F' }).expect(201)).body.client.id as string;
    const g = (await asOwner('post', '/clients').send({ code: 'BRAND-G', name: 'Brand G' }).expect(201)).body.client.id as string;
    const shared = await createPartner({ code: 'P-FG', name: 'Shared default', roles: ['vendor'] });
    await link(shared.id, { clientId: f, role: 'vendor', isDefault: true });
    await link(shared.id, { clientId: g, role: 'vendor', isDefault: true });
    const other = await createPartner({ code: 'P-F2', name: 'F second', roles: ['vendor'] });
    await link(other.id, { clientId: f, role: 'vendor', isDefault: true });
    const after = (await asOwner('get', `/partners?q=P-FG`).expect(200)).body.items[0] as Partner;
    expect(linkOf(after, f).isDefault).toBe(false);
    expect(linkOf(after, g).isDefault).toBe(true);
  });

  // ── the list ───────────────────────────────────────────────────────────────

  it('list: by code with links inline; role, clientId (active links only), status and an escaped q filter; the keyset walks with no dup or miss', async () => {
    const all = await asOwner('get', '/partners?limit=200').expect(200);
    const items = all.body.items as Partner[];
    const codes = items.map((row) => row.code);
    expect(codes).toEqual([...codes].sort());
    expect(items.find((row) => row.code === 'P-L')!.links.length).toBeGreaterThan(0);

    const transporters = (await asOwner('get', '/partners?role=transporter').expect(200)).body.items as Partner[];
    expect(transporters.every((row) => row.roles.includes('transporter'))).toBe(true);
    expect(transporters.map((row) => row.code)).toContain('T-1');

    const forC = (await asOwner('get', `/partners?role=vendor&clientId=${clientC}`).expect(200)).body.items as Partner[];
    expect(forC.every((row) => row.links.some((l) => l.clientId === clientC && l.role === 'vendor' && l.active))).toBe(true);
    expect(forC.map((row) => row.code)).toContain('P-L');
    expect(forC.map((row) => row.code)).not.toContain('P-DA'); // its C link is switched off

    const inactive = (await asOwner('get', '/partners?status=inactive').expect(200)).body.items as Partner[];
    expect(inactive.every((row) => row.status === 'inactive')).toBe(true);

    expect(((await asOwner('get', '/partners?q=konkan').expect(200)).body.items as Partner[]).map((row) => row.code)).toEqual(['P-2']);
    expect(((await asOwner('get', `/partners?q=${G2.slice(0, 8)}`).expect(200)).body.items as Partner[]).map((row) => row.code)).toEqual(['P-2']);
    expect((await asOwner('get', `/partners?q=${encodeURIComponent('%')}`).expect(200)).body.items).toEqual([]);
    expect((await asOwner('get', `/partners?q=${encodeURIComponent('P_')}`).expect(200)).body.items).toEqual([]);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 100; guard += 1) {
      const page: request.Response = await asOwner('get', `/partners?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`).expect(200);
      seen.push(...(page.body.items as Partner[]).map((row) => row.code));
      cursor = page.body.nextCursor as string | null;
      if (cursor === null) break;
    }
    expect(seen).toEqual(codes);
    await asOwner('get', '/partners?cursor=not-a-cursor').expect(400);
  });

  // ── races ──────────────────────────────────────────────────────────────────

  it('same-key races: two parked duplicates of each lock-taking command answer the same body — one effect, one audit row, one key', async () => {
    const p = await createPartner({ code: 'P-RACE', name: 'Race Vendor', roles: ['vendor'] });
    const cases: { key: string; send: () => SupertestTest; status: number }[] = [];
    const editKey = ulid();
    cases.push({ key: editKey, send: () => asOwner('patch', `/partners/${p.id}`, editKey).send({ name: 'Race Vendor 2' }), status: 200 });
    const linkKey = ulid();
    cases.push({ key: linkKey, send: () => asOwner('post', `/partners/${p.id}/links`, linkKey).send({ clientId: clientC, role: 'vendor' }), status: 201 });
    for (const { key, send, status } of cases) {
      const [a, b] = await raceTwice(p.id, send);
      expect(a.status).toBe(status);
      expect(b.status).toBe(status);
      expect(b.body).toEqual(a.body);
      expect(await auditCount(key)).toBe(1);
      expect(await keyCount(key)).toBe(1);
    }
    const linkId = linkOf((await asOwner('get', '/partners?q=P-RACE').expect(200)).body.items[0] as Partner, clientC).id;
    const linkEditKey = ulid();
    const [la, lb] = await raceTwice(p.id, () => asOwner('patch', `/partners/${p.id}/links/${linkId}`, linkEditKey).send({ active: false }));
    expect([la.status, lb.status]).toEqual([200, 200]);
    expect(lb.body).toEqual(la.body);
    expect(await auditCount(linkEditKey)).toBe(1);
    const statusKey = ulid();
    const [sa, sb] = await raceTwice(p.id, () => asOwner('patch', `/partners/${p.id}/status`, statusKey).send({ status: 'inactive' }));
    expect([sa.status, sb.status]).toEqual([200, 200]);
    expect(sb.body).toEqual(sa.body);
    expect(await auditCount(statusKey)).toBe(1);
    expect(await keyCount(statusKey)).toBe(1);
  });

  it('deactivate vs PO create serialise: a deactivation waits for an in-flight PO\'s key share; a PO arriving behind a committing deactivation is refused; a rename never waits', async () => {
    const v = await createPartner({ code: 'P-SER', name: 'Serial Vendor', roles: ['vendor'] });
    await link(v.id, { clientId: selfClient, role: 'vendor' });

    // (1) An in-flight PO create holds the partner FOR KEY SHARE: a rename
    // (FOR NO KEY UPDATE) does not queue, a deactivation (FOR UPDATE) does.
    const holder = handle();
    let deactivation: Promise<request.Response> | undefined;
    try {
      await holder.begin(async (tx) => {
        const locked = (await tx`
          select pg_backend_pid() as pid from business_partners where tenant_id = ${tenantId} and id = ${v.id} for key share
        `) as unknown as { pid: number }[];
        await asOwner('patch', `/partners/${v.id}`).send({ contactName: 'Not queued' }).expect(200);
        deactivation = (async () => asOwner('patch', `/partners/${v.id}/status`).send({ status: 'inactive' }))();
        await waitParked('business_partners', locked[0]!.pid, 1);
      });
      expect((await deactivation!).status).toBe(200);
    } finally {
      await Promise.allSettled([deactivation]);
      await holder.end();
    }

    // (2) A PO create parked behind a deactivation that then commits reads
    // the inactive row and is refused.
    await asOwner('patch', `/partners/${v.id}/status`).send({ status: 'active' }).expect(200);
    const blocker = handle();
    let po: Promise<request.Response> | undefined;
    try {
      await blocker.begin(async (tx) => {
        const locked = (await tx`
          select pg_backend_pid() as pid from business_partners where tenant_id = ${tenantId} and id = ${v.id} for update
        `) as unknown as { pid: number }[];
        po = (async () => createPo(v.id, skuSelf))();
        await waitParked('business_partners', locked[0]!.pid, 1);
        await tx`update business_partners set status = 'inactive' where id = ${v.id}`;
      });
      const refused = await po!;
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'vendor-inactive' });
    } finally {
      await Promise.allSettled([po]);
      await blocker.end();
    }
  });

  it('two concurrent set-defaults for one client: both answer, one default stands', async () => {
    const client = (await asOwner('post', '/clients').send({ code: 'BRAND-D', name: 'Brand D' }).expect(201)).body.client.id as string;
    const x = await createPartner({ code: 'P-DX', name: 'Default X', roles: ['vendor'] });
    const y = await createPartner({ code: 'P-DY', name: 'Default Y', roles: ['vendor'] });
    const xLink = linkOf(await link(x.id, { clientId: client, role: 'vendor' }), client).id;
    const yLink = linkOf(await link(y.id, { clientId: client, role: 'vendor' }), client).id;
    const holder = handle();
    let first: Promise<request.Response> | undefined;
    let second: Promise<request.Response> | undefined;
    try {
      await holder.begin(async (tx) => {
        const locked = (await tx`
          select pg_backend_pid() as pid from clients where tenant_id = ${tenantId} and id = ${client} for no key update
        `) as unknown as { pid: number }[];
        first = (async () => asOwner('patch', `/partners/${x.id}/links/${xLink}`).send({ isDefault: true }))();
        second = (async () => asOwner('patch', `/partners/${y.id}/links/${yLink}`).send({ isDefault: true }))();
        await waitParked('clients', locked[0]!.pid, 2);
      });
      const answers = await Promise.all([first!, second!]);
      for (const answer of answers) {
        expect([200, 409]).toContain(answer.status);
        if (answer.status === 409) expect(answer.body).toMatchObject({ code: 'default-vendor-conflict' });
      }
    } finally {
      await Promise.allSettled([first, second]);
      await holder.end();
    }
    const defaults = (await sql`
      select count(*)::int as n from partner_client_links where tenant_id = ${tenantId} and client_id = ${client} and is_default`) as unknown as {
      n: number;
    }[];
    expect(Number(defaults[0]!.n)).toBe(1);
  });

  // ── vocabularies, RLS, OpenAPI ────────────────────────────────────────────

  it('the TS vocabularies equal the 0079 CHECKs', async () => {
    const rows = (await sql`
      select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conname in ('business_partners_roles_check', 'business_partners_status_check', 'partner_client_links_role_check')`) as unknown as {
      conname: string;
      def: string;
    }[];
    const def = (name: string): string => rows.find((row) => row.conname === name)!.def;
    for (const role of PARTNER_ROLES) expect(def('business_partners_roles_check')).toContain(`'${role}'`);
    expect(def('business_partners_roles_check').match(/'(vendor|consignee|transporter)'/g)!.length).toBeGreaterThanOrEqual(PARTNER_ROLES.length);
    for (const status of PARTNER_STATUSES) expect(def('business_partners_status_check')).toContain(`'${status}'`);
    for (const role of PARTNER_LINK_ROLES) expect(def('partner_client_links_role_check')).toContain(`'${role}'`);
    expect(def('partner_client_links_role_check')).not.toContain('transporter');
  });

  it('RLS: links are client-scoped — a portal-stamped session sees only its own client\'s links; partners are tenant-scoped', async () => {
    const p = await createPartner({ code: 'P-RLS', name: 'RLS Vendor', roles: ['vendor'] });
    await link(p.id, { clientId: clientC, role: 'vendor' });
    await link(p.id, { clientId: selfClient, role: 'vendor' });
    const url = new URL(process.env.DATABASE_URL!);
    url.username = 'wms_rls_probe';
    url.password = 'wms_rls_probe';
    const rls = postgres(url.toString(), { max: 1 });
    try {
      const count = async (clientStamp: string | null, table: string): Promise<number> =>
        rls.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
          if (clientStamp !== null) await tx`select set_config('app.client_id', ${clientStamp}, true)`;
          const rows = (await tx.unsafe(`select count(*)::int as n from ${table} where partner_id = '${p.id}'::uuid`)) as unknown as { n: number }[];
          return Number(rows[0]!.n);
        }) as Promise<number>;
      expect(await count(null, 'partner_client_links')).toBe(2);
      expect(await count(clientC, 'partner_client_links')).toBe(1);
      const foreign = await rls.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${uuidv7()}, true)`;
        return tx`select count(*)::int as n from business_partners where id = ${p.id}`;
      });
      expect(Number((foreign[0] as unknown as { n: number }).n)).toBe(0);
    } finally {
      await rls.end();
    }
  });

  it('OpenAPI: the partner routes are published and the vendor routes are gone', async () => {
    const doc = (await http().get('/api/v1/openapi.json').expect(200)).body as { paths: Record<string, unknown> };
    const base = '/tenants/{tenantId}';
    for (const path of ['/partners', '/partners/{partnerId}', '/partners/{partnerId}/status', '/partners/{partnerId}/links', '/partners/{partnerId}/links/{linkId}']) {
      expect(doc.paths[`${base}${path}`]).toBeDefined();
    }
    expect(doc.paths[`${base}/vendors`]).toBeUndefined();
  });
});
