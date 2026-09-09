import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';

// The e2e suite talks to the real Postgres (docker-compose dev DB by
// default; CI provides the service container) and signs sessions.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
// A host that exports either poll interval would boot the background workers
// and race these tests — the same convention as the sibling suites.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

describe('inbound: vendors + purchase orders (e2e, story 3.1)', () => {
  let app: INestApplication;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let warehouseId: string;
  let vendorId: string;
  const skuIds = new Map<string, string>();

  beforeAll(async () => {
    // Same deployment-parity probes as the sibling suites (auth + RLS roles,
    // serialized across parallel jest workers by the advisory lock — no new
    // advisory lock keys needed).
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(742106)`;
        await tx.unsafe(`
          do $$ begin
            if not exists (select from pg_roles where rolname = 'wms_auth_probe') then
              create role wms_auth_probe login password 'wms_auth_probe' nosuperuser bypassrls;
            end if;
            if not exists (select from pg_roles where rolname = 'wms_rls_probe') then
              create role wms_rls_probe login password 'wms_rls_probe' nosuperuser;
            end if;
          end $$;
        `);
        await tx.unsafe('grant usage on schema public to wms_auth_probe, wms_rls_probe');
        await tx.unsafe(
          'grant select, insert, update, delete on all tables in schema public to wms_auth_probe, wms_rls_probe',
        );
      });
      const authUrl = new URL(process.env.DATABASE_URL!);
      authUrl.username = 'wms_auth_probe';
      authUrl.password = 'wms_auth_probe';
      process.env.DATABASE_AUTH_URL = authUrl.toString();
    } finally {
      await admin.end();
    }
    app = await createApp(false);
    await app.init();
  });

  afterAll(async () => {
    await cleanupRows();
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
  });

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      // Children before parents (no FKs, but the order keeps the intent
      // legible): PO lines → POs → vendors, then the shared spine rows.
      await sql.unsafe('DELETE FROM purchase_order_lines WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM purchase_orders WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM vendors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM outbox_messages WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM uom_conversions WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM catalog_import_errors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM catalog_imports WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM skus WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM bins WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM zones WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM warehouses WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM tenants WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
    } finally {
      await sql.end();
    }
  }

  interface PoLineInput {
    skuId: string;
    orderedQty: number;
    unitCostPaise: number;
    expectedDate?: string;
  }

  interface PoBody {
    warehouseId: string;
    vendorId: string;
    code: string;
    lines: PoLineInput[];
  }

  function createPo(body: PoBody, key = ulid()): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/inbound/purchase-orders`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function amendPo(poId: string, lines: (PoLineInput & { id?: string })[], key = ulid()): SupertestTest {
    return request(app.getHttpServer())
      .patch(`${API}/${tenantId}/inbound/purchase-orders/${poId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, key)
      .send({ lines });
  }

  function closePo(
    poId: string,
    lines: { lineId: string; disposition: 'cancelled' | 'carried' }[],
    key = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/inbound/purchase-orders/${poId}/close`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, key)
      .send({ lines });
  }

  function get(path: string): SupertestTest {
    return request(app.getHttpServer()).get(`${API}/${tenantId}${path}`).set('Authorization', `Bearer ${ownerToken}`);
  }

  async function dbCount(table: string, extra = '', params: string[] = []): Promise<number> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql.unsafe(
        `select count(*)::int as n from ${table} where tenant_id = $1 ${extra}`,
        [tenantId, ...params],
      );
      return Number((rows[0] as unknown as { n: number }).n);
    } finally {
      await sql.end();
    }
  }

  /** One invite → accept → sign-in round trip: an active team user of a role. */
  async function createMember(role: 'ops_manager' | 'operator'): Promise<{ userId: string; email: string; token: string }> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role })
      .expect(201);
    const userId = invited.body.user.id as string;
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    const token = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;
    return { userId, email, token };
  }

  beforeAll(async () => {
    // Tenant + owner.
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Inbound Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;

    // Warehouse → zone → one bin (bins are irrelevant to POs; the shape is).
    const warehouse = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: `INB-${ulid().slice(10, 16).toUpperCase()}`, name: `Inboundpoint ${ulid()}` })
      .expect(201);
    warehouseId = warehouse.body.id as string;

    // Two SKUs via the import (the only SKU-creation path).
    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const csv = [
      csvHeader,
      'INB-A,Inbound Item A,pcs,,1800,,false,false,,,',
      'INB-B,Inbound Item B,pcs,,1800,,false,false,,,',
    ].join('\n');
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const skus = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/skus`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    for (const item of skus.body.items as { code: string; id: string }[]) {
      skuIds.set(item.code, item.id);
    }
    expect(skuIds.size).toBe(2);

    // The tenant's vendor (used by most PO tests below).
    vendorId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/vendors`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'VEND-001', name: 'Prime Foods Pvt Ltd' })
        .expect(201)
    ).body.vendor.id as string;
  });

  // ── Vendor surfaces ────────────────────────────────────────────────────────

  it('vendor create: 201 with the snapshot; duplicate code is 409 conflict naming the code; the list walks the keyset', async () => {
    const created = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/vendors`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'VEND-002', name: 'Spice Traders', isDefault: true })
      .expect(201);
    expect(created.body.vendor).toMatchObject({
      tenantId,
      code: 'VEND-002',
      name: 'Spice Traders',
      isDefault: true,
    });

    // The `vendor.created` outbox row exists exactly once, carrying the
    // post-mutation vendor snapshot.
    {
      const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
      try {
        const events = await sql`
          select payload from outbox_messages
          where tenant_id = ${tenantId} and type = 'vendor.created'
          and payload->'vendor'->>'id' = ${created.body.vendor.id as string}`;
        const rows = events as unknown as { payload: { vendor: { code: string } } }[];
        expect(rows).toHaveLength(1);
        expect(rows[0]!.payload.vendor.code).toBe('VEND-002');
      } finally {
        await sql.end();
      }
    }

    // A verbatim same-key resend replays the stored snapshot.
    const vendorKey = ulid();
    const vendorFirst = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/vendors`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, vendorKey)
      .send({ code: 'VEND-REPLAY', name: 'Replay Traders' })
      .expect(201);
    const vendorSecond = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/vendors`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, vendorKey)
      .send({ code: 'VEND-REPLAY', name: 'Replay Traders' })
      .expect(201);
    expect(vendorSecond.body).toEqual(vendorFirst.body);

    const duplicate = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/vendors`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'VEND-001', name: 'Another Prime' })
      .expect(409);
    expect(duplicate.body).toMatchObject({ status: 409, code: 'conflict' });
    expect(duplicate.body.detail).toContain('VEND-001');

    // The list: both vendors, keyset cursor walks with no dup/miss.
    const first = await get('/vendors?limit=1').expect(200);
    expect(first.body.items).toHaveLength(1);
    const seen = (first.body.items as { code: string }[]).map((item) => item.code);
    let nextCursor = first.body.nextCursor as string | null;
    let guard = 0;
    while (nextCursor !== null && guard < 20) {
      const page = await get(`/vendors?limit=1&cursor=${encodeURIComponent(nextCursor)}`).expect(200);
      seen.push(...(page.body.items as { code: string }[]).map((item) => item.code));
      nextCursor = page.body.nextCursor as null | string;
      guard += 1;
    }
    expect(nextCursor).toBeNull();
    expect(seen).toHaveLength(await dbCount('vendors'));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('vendor create errors: an operator is 403 role-denied; a foreign tenant is 403; no token is 401', async () => {
    const operator = await createMember('operator');
    const denied = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/vendors`)
      .set('Authorization', `Bearer ${operator.token}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'VEND-NOPE', name: 'Blocked Traders' })
      .expect(403);
    expect(denied.body).toMatchObject({ status: 403, code: 'role-denied' });

    await request(app.getHttpServer())
      .post(`${API}/${uuidv7()}/vendors`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'VEND-X', name: 'Foreign' })
      .expect(403)
      .then((res) => expect(res.body).toMatchObject({ code: 'permission-denied' }));

    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/vendors`)
      .send({ code: 'VEND-X', name: 'No token' })
      .expect(401);
  });

  // ── PO create: happy path + every error arm ───────────────────────────────

  it('PO create: 201 open with per-line ordered / received (0) / open; the outbox carries the full snapshot', async () => {
    const body: PoBody = {
      warehouseId,
      vendorId,
      code: `PO-${ulid().slice(10, 18).toUpperCase()}`,
      lines: [
        { skuId: skuIds.get('INB-A')!, orderedQty: 10, unitCostPaise: 1250, expectedDate: new Date(Date.now() + 86_400_000).toISOString() },
        { skuId: skuIds.get('INB-B')!, orderedQty: 5, unitCostPaise: 4000 },
      ],
    };
    const created = await createPo(body).expect(201);
    const po = created.body.purchaseOrder as { id: string } & Record<string, unknown>;
    expect(po).toMatchObject({
      tenantId,
      warehouseId,
      vendorId,
      code: body.code,
      status: 'open',
      carriedFromPoId: null,
    });
    const lines = po.lines as { poId: string; skuId: string; orderedQty: number; receivedQty: number; openQty: number; status: string; expectedDate: string | null }[];
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.receivedQty).toBe(0);
      expect(line.openQty).toBe(line.orderedQty);
      expect(line.status).toBe('open');
      expect(line.poId).toBe(po.id);
    }
    expect((lines[0] as { expectedDate: string }).expectedDate).toBeTruthy();
    expect((lines[1] as { expectedDate: string | null }).expectedDate).toBeNull();

    // The detail read returns exactly the snapshot shape.
    const detail = await get(`/inbound/purchase-orders/${po.id}`).expect(200);
    expect(detail.body.purchaseOrder).toEqual(po);

    // One in-tx outbox row carrying the full post-mutation snapshot.
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const events = await sql`
        select payload from outbox_messages
        where tenant_id = ${tenantId} and type = 'po.created'
        and payload->'purchaseOrder'->>'id' = ${po.id}`;
      const rows = events as unknown as { payload: { purchaseOrder: { id: string; lines: unknown[] } } }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload.purchaseOrder.lines).toHaveLength(2);
    } finally {
      await sql.end();
    }
  });

  it('PO create errors: unknown warehouse/vendor/SKU is 404; duplicate code is 409 naming the code; non-positive qty/cost and a malformed expectedDate are 400', async () => {
    const base: PoBody = {
      warehouseId,
      vendorId,
      code: `PO-${ulid().slice(10, 18).toUpperCase()}`,
      lines: [{ skuId: skuIds.get('INB-A')!, orderedQty: 1, unitCostPaise: 100 }],
    };
    const posBefore = await dbCount('purchase_orders');

    const foreignWarehouse = await createPo({ ...base, warehouseId: uuidv7() }).expect(404);
    expect(foreignWarehouse.body).toMatchObject({ status: 404, code: 'not-found' });

    const foreignVendor = await createPo({ ...base, vendorId: uuidv7() }).expect(404);
    expect(foreignVendor.body).toMatchObject({ status: 404, code: 'not-found' });

    const foreignSku = await createPo({
      ...base,
      lines: [{ skuId: uuidv7(), orderedQty: 1, unitCostPaise: 100 }],
    }).expect(404);
    expect(foreignSku.body).toMatchObject({ status: 404, code: 'not-found' });
    expect(foreignSku.body.detail).toContain('SKU');

    // Duplicate code: a first create succeeds, the second with the same code
    // is rejected naming the code.
    await createPo(base).expect(201);
    const duplicate = await createPo(base).expect(409);
    expect(duplicate.body).toMatchObject({ status: 409, code: 'conflict' });
    expect(duplicate.body.detail).toContain(base.code);

    await createPo({ ...base, lines: [{ skuId: skuIds.get('INB-A')!, orderedQty: 0, unitCostPaise: 100 }] }).expect(400);
    await createPo({ ...base, lines: [{ skuId: skuIds.get('INB-A')!, orderedQty: 3, unitCostPaise: 0 }] }).expect(400);
    await createPo({
      ...base,
      lines: [{ skuId: skuIds.get('INB-A')!, orderedQty: 3, unitCostPaise: 100, expectedDate: '2026-09-01' }],
    }).expect(400);

    // A missing Idempotency-Key header is a 400 before any command runs.
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/inbound/purchase-orders`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(base)
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'idempotency-key-required' }));

    // Rollback discipline: only the one successful create above persisted —
    // every 404/409/400 attempt left no partial PO rows behind.
    expect(await dbCount('purchase_orders')).toBe(posBefore + 1);
  });

  // ── Amend: recompute, add/remove lines, receivedQty untouched ─────────────

  it('PO amend: changed quantity, an added line and a removed line; receivedQty stays 0; open recomputes; po.amended lands in the outbox', async () => {
    const created = await createPo({
      warehouseId,
      vendorId,
      code: `PO-${ulid().slice(10, 18).toUpperCase()}`,
      lines: [
        { skuId: skuIds.get('INB-A')!, orderedQty: 10, unitCostPaise: 1000 },
        { skuId: skuIds.get('INB-B')!, orderedQty: 4, unitCostPaise: 2000 },
      ],
    }).expect(201);
    const poId = (created.body.purchaseOrder as { id: string }).id;
    const originalLines = (created.body.purchaseOrder as { lines: { id: string; skuId: string; orderedQty: number }[] }).lines;

    const amended = await amendPo(poId, [
      // Line 1: quantity changed 10 → 7.
      { id: originalLines[0]!.id, skuId: skuIds.get('INB-A')!, orderedQty: 7, unitCostPaise: 1000 },
      // Line 2 dropped (absent = removed) …
      // … and a fresh third line added.
      { skuId: skuIds.get('INB-B')!, orderedQty: 9, unitCostPaise: 3000 },
    ]).expect(200);
    const po = amended.body.purchaseOrder as { id: string; lines: { id: string; skuId: string; orderedQty: number; receivedQty: number; openQty: number; status: string }[] };
    expect(po.id).toBe(poId);
    expect(po.lines).toHaveLength(2);
    const bySku = new Map(po.lines.map((line) => [line.skuId, line]));
    expect(bySku.get(skuIds.get('INB-A')!)).toMatchObject({ orderedQty: 7, receivedQty: 0, openQty: 7, status: 'open' });
    expect(bySku.get(skuIds.get('INB-B')!)).toMatchObject({ orderedQty: 9, receivedQty: 0, openQty: 9, status: 'open' });
    expect(bySku.get(skuIds.get('INB-B')!)!.id).not.toBe(originalLines[1]!.id);
    expect(po.lines.some((line) => line.id === originalLines[0]!.id)).toBe(true);

    // The outbox row carries the full post-amendment snapshot.
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const events = await sql`
        select payload from outbox_messages where tenant_id = ${tenantId} and type = 'po.amended'
        and payload->'purchaseOrder'->>'id' = ${poId}`;
      const payloads = events as unknown as { payload: { purchaseOrder: { id: string; lines: unknown[] } } }[];
      expect(payloads).toHaveLength(1);
      expect(payloads[0]!.payload.purchaseOrder.lines).toHaveLength(2);
    } finally {
      await sql.end();
    }

    // The amend is idempotent-snapshot-safe: a verbatim resend replays the
    // stored snapshot without re-executing (a fresh key re-executes and
    // appends a second po.amended — the same line set, the same result).
    const replayKey = ulid();
    const first = await amendPo(poId, [
      { id: originalLines[0]!.id, skuId: skuIds.get('INB-A')!, orderedQty: 7, unitCostPaise: 1000 },
      { skuId: skuIds.get('INB-B')!, orderedQty: 9, unitCostPaise: 3000 },
    ], replayKey).expect(200);
    const second = await amendPo(poId, [
      { id: originalLines[0]!.id, skuId: skuIds.get('INB-A')!, orderedQty: 7, unitCostPaise: 1000 },
      { skuId: skuIds.get('INB-B')!, orderedQty: 9, unitCostPaise: 3000 },
    ], replayKey).expect(200);
    expect(second.body).toEqual(first.body);
    expect(second.body.purchaseOrder).toMatchObject({ id: poId });

    // Unknown line id → 404 naming it.
    const unknownLine = await amendPo(poId, [
      { id: uuidv7(), skuId: skuIds.get('INB-A')!, orderedQty: 1, unitCostPaise: 100 },
    ]).expect(404);
    expect(unknownLine.body).toMatchObject({ status: 404, code: 'not-found' });

    // An empty line set would strip the PO to zero lines — 400 (the same
    // ≥1-line invariant create enforces).
    await amendPo(poId, []).expect(400);

    // A repeated line id is ambiguous under full-line-set semantics — 400.
    await amendPo(poId, [
      { id: originalLines[0]!.id, skuId: skuIds.get('INB-A')!, orderedQty: 7, unitCostPaise: 1000 },
      { id: originalLines[0]!.id, skuId: skuIds.get('INB-A')!, orderedQty: 8, unitCostPaise: 1000 },
    ]).expect(400);

    // The PO header's `updatedAt` advanced past `createdAt` (the amend only
    // touched lines, but the PO's mutation instant still moves).
    const afterAmend = await get(`/inbound/purchase-orders/${poId}`).expect(200);
    const header = afterAmend.body.purchaseOrder as { createdAt: string; updatedAt: string };
    expect(new Date(header.updatedAt).getTime()).toBeGreaterThan(new Date(header.createdAt).getTime());
  });

  // ── Close: dispositions, the successor, and the closed-PO mutation rule ───

  it('PO close with one cancelled and one carried line: the successor holds the carried quantity, the original shows its dispositions', async () => {
    const created = await createPo({
      warehouseId,
      vendorId,
      code: `PO-${ulid().slice(10, 18).toUpperCase()}`,
      lines: [
        { skuId: skuIds.get('INB-A')!, orderedQty: 12, unitCostPaise: 1500, expectedDate: new Date(Date.now() + 86_400_000).toISOString() },
        { skuId: skuIds.get('INB-B')!, orderedQty: 8, unitCostPaise: 2500 },
      ],
    }).expect(201);
    const original = created.body.purchaseOrder as { id: string; code: string; lines: { id: string; orderedQty: number }[] };
    const [lineA, lineB] = original.lines;

    const closed = await closePo(original.id, [
      { lineId: lineA!.id, disposition: 'carried' },
      { lineId: lineB!.id, disposition: 'cancelled' },
    ]).expect(200);
    const closedPo = closed.body.purchaseOrder as { id: string; status: string; lines: { id: string; status: string; orderedQty: number; receivedQty: number; openQty: number }[] };
    expect(closedPo.status).toBe('closed');
    expect(closedPo.lines).toHaveLength(2);
    expect(closedPo.lines.map((line) => line.status).sort()).toEqual(['cancelled', 'carried']);
    // Quantities remain queryable exactly as at close (received untouched).
    for (const line of closedPo.lines) {
      expect(line.receivedQty).toBe(0);
      expect(line.openQty).toBe(line.orderedQty);
    }

    // The successor: one open PO carrying the carried line's open quantity.
    const successor = closed.body.successor as { id: string; code: string; status: string; carriedFromPoId: string; lines: { skuId: string; orderedQty: number; receivedQty: number; openQty: number }[] };
    expect(successor).not.toBeNull();
    expect(successor.carriedFromPoId).toBe(original.id);
    expect(successor.status).toBe('open');
    expect(successor.code).toBe(`${original.code}-C1`);
    expect(successor.lines).toHaveLength(1);
    expect(successor.lines[0]).toMatchObject({
      skuId: skuIds.get('INB-A')!,
      orderedQty: lineA!.orderedQty,
      receivedQty: 0,
      openQty: lineA!.orderedQty,
    });

    // The closed PO's detail read stays queryable with its dispositions.
    const detail = await get(`/inbound/purchase-orders/${original.id}`).expect(200);
    expect((detail.body.purchaseOrder as { status: string }).status).toBe('closed');
    expect((detail.body.purchaseOrder as { lines: { status: string }[] }).lines.map((line) => line.status).sort()).toEqual(['cancelled', 'carried']);

    // The successor shows up in the open-status list; the original in closed.
    const openList = await get(`/warehouses/${warehouseId}/inbound/purchase-orders?status=open`).expect(200);
    expect((openList.body.items as { id: string }[]).some((item) => item.id === successor.id)).toBe(true);
    expect((openList.body.items as { id: string }[]).some((item) => item.id === original.id)).toBe(false);
    const closedList = await get(`/warehouses/${warehouseId}/inbound/purchase-orders?status=closed`).expect(200);
    expect((closedList.body.items as { id: string }[]).some((item) => item.id === original.id)).toBe(true);

    // Any later mutation against the original is rejected naming the PO state.
    const amend = await amendPo(original.id, [
      { skuId: skuIds.get('INB-A')!, orderedQty: 1, unitCostPaise: 100 },
    ]).expect(409);
    expect(amend.body).toMatchObject({ status: 409, code: 'po-not-open' });
    expect(amend.body.detail).toContain('closed');

    const reClose = await closePo(original.id, [
      { lineId: lineA!.id, disposition: 'cancelled' },
      { lineId: lineB!.id, disposition: 'cancelled' },
    ]).expect(409);
    expect(reClose.body).toMatchObject({ status: 409, code: 'po-not-open' });

    // Exactly one `po.closed` outbox row, carrying the closed PO and its
    // successor (the successor PO itself on the payload).
    {
      const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
      try {
        const events = await sql`
          select payload from outbox_messages
          where tenant_id = ${tenantId} and type = 'po.closed'
          and payload->'purchaseOrder'->>'id' = ${original.id}`;
        const rows = events as unknown as { payload: { purchaseOrder: { status: string }; successor: { id: string } | null } }[];
        expect(rows).toHaveLength(1);
        expect(rows[0]!.payload.purchaseOrder.status).toBe('closed');
        expect(rows[0]!.payload.successor?.id).toBe(successor.id);
      } finally {
        await sql.end();
      }
    }
  });

  it('PO close replay: a verbatim same-key resend re-serves the stored snapshot — and the closed header updatedAt advanced', async () => {
    const created = await createPo({
      warehouseId,
      vendorId,
      code: `PO-${ulid().slice(10, 18).toUpperCase()}`,
      lines: [{ skuId: skuIds.get('INB-B')!, orderedQty: 2, unitCostPaise: 500 }],
    }).expect(201);
    const po = created.body.purchaseOrder as { id: string; lines: { id: string }[] };

    const closeKey = ulid();
    const body = [{ lineId: po.lines[0]!.id, disposition: 'cancelled' as const }];
    const first = await closePo(po.id, body, closeKey).expect(200);
    const second = await closePo(po.id, body, closeKey).expect(200);
    expect(second.body).toEqual(first.body);
    expect((second.body.purchaseOrder as { status: string }).status).toBe('closed');

    const header = (await get(`/inbound/purchase-orders/${po.id}`).expect(200)).body.purchaseOrder as {
      createdAt: string;
      updatedAt: string;
    };
    expect(new Date(header.updatedAt).getTime()).toBeGreaterThan(new Date(header.createdAt).getTime());
  });

  it('PO close validation: missing/unknown/duplicate dispositions, all-cancelled → no successor, and a carried line with nothing left is 400', async () => {
    const created = await createPo({
      warehouseId,
      vendorId,
      code: `PO-${ulid().slice(10, 18).toUpperCase()}`,
      lines: [{ skuId: skuIds.get('INB-A')!, orderedQty: 3, unitCostPaise: 700 }],
    }).expect(201);
    const po = created.body.purchaseOrder as { id: string; lines: { id: string }[] };
    const lineId = po.lines[0]!.id;

    // Close is total: a missing disposition is 400, an unknown line id 404,
    // a duplicate disposition 400 — and none of these attempts closed the PO.
    await closePo(po.id, []).expect(400);
    await closePo(po.id, [{ lineId: uuidv7(), disposition: 'cancelled' }]).expect(404);
    await closePo(po.id, [
      { lineId, disposition: 'cancelled' },
      { lineId, disposition: 'carried' },
    ]).expect(400);
    expect((await get(`/inbound/purchase-orders/${po.id}`).expect(200)).body.purchaseOrder).toMatchObject({ status: 'open' });

    // All cancelled → the close succeeds with no successor.
    const closed = await closePo(po.id, [{ lineId, disposition: 'cancelled' }]).expect(200);
    expect(closed.body.successor).toBeNull();
    expect(closed.body.purchaseOrder).toMatchObject({ status: 'closed' });
    expect((closed.body.purchaseOrder as { lines: { status: string }[] }).lines[0]!.status).toBe('cancelled');

    // A carried line with no open quantity is a 400 ("nothing left to
    // carry"). Ordered − received ≤ 0 is unreachable through the 3.1 API
    // (received ships at 0), so seed the 3.3-shaped line directly: received
    // up to ordered, then attempt to carry it.
    const receivedPo = (
      await createPo({
        warehouseId,
        vendorId,
        code: `PO-${ulid().slice(10, 18).toUpperCase()}`,
        lines: [{ skuId: skuIds.get('INB-B')!, orderedQty: 4, unitCostPaise: 800 }],
      }).expect(201)
    ).body.purchaseOrder as { id: string; lines: { id: string; orderedQty: number }[] };
    const receivedLine = receivedPo.lines[0]!;
    const seedSql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await seedSql`
        update purchase_order_lines set received_qty = ${receivedLine.orderedQty}
        where id = ${receivedLine.id} and tenant_id = ${tenantId}`;
    } finally {
      await seedSql.end();
    }
    const nothing = await closePo(receivedPo.id, [{ lineId: receivedLine.id, disposition: 'carried' }]).expect(400);
    expect(nothing.body).toMatchObject({ status: 400, code: 'validation-failed' });
    expect(nothing.body.detail).toContain('carry');
    // The failed close left the PO open with its received quantity intact.
    expect((await get(`/inbound/purchase-orders/${receivedPo.id}`).expect(200)).body.purchaseOrder).toMatchObject({ status: 'open' });
  });

  // ── Idempotency: replay, hash mismatch, demoted actor ─────────────────────

  it('replay: the same key + payload re-serves the snapshot with no second outbox row; a different payload is 422; a demoted actor is 403 before replay', async () => {
    // A dedicated ops manager so the demotion below is real.
    const ops = await createMember('ops_manager');

    const body: PoBody = {
      warehouseId,
      vendorId,
      code: `PO-${ulid().slice(10, 18).toUpperCase()}`,
      lines: [{ skuId: skuIds.get('INB-A')!, orderedQty: 2, unitCostPaise: 999 }],
    };
    const key = ulid();
    const send = (keyOverride = key): SupertestTest =>
      request(app.getHttpServer())
        .post(`${API}/${tenantId}/inbound/purchase-orders`)
        .set('Authorization', `Bearer ${ops.token}`)
        .set(KEY_HEADER, keyOverride)
        .send(body);

    const first = await send().expect(201);
    const replayed = await send().expect(201);
    expect(replayed.body).toEqual(first.body);

    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`
        select count(*)::int as n from outbox_messages
        where tenant_id = ${tenantId} and type = 'po.created'
        and payload->'purchaseOrder'->>'id' = ${(first.body.purchaseOrder as { id: string }).id}`;
      expect(Number((rows[0] as unknown as { n: number }).n)).toBe(1);
    } finally {
      await sql.end();
    }

    // Same key, different payload → 422 idempotency-key-reuse.
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/inbound/purchase-orders`)
      .set('Authorization', `Bearer ${ops.token}`)
      .set(KEY_HEADER, key)
      .send({ ...body, lines: [{ skuId: skuIds.get('INB-A')!, orderedQty: 3, unitCostPaise: 999 }] })
      .expect(422)
      .then((res) => expect(res.body).toMatchObject({ code: 'idempotency-key-reuse' }));

    // Demote the actor → 403 role-denied BEFORE the replay (the fail-closed
    // carve-out), never the stored snapshot.
    await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/users/${ops.userId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ role: 'operator' })
      .expect(200);
    await send().expect(403).then((res) => expect(res.body).toMatchObject({ code: 'role-denied' }));
  });

  // ── Reads: keyset paging, filters, error arms ─────────────────────────────

  it('PO list: walks the keyset to exhaustion with no dup/miss; malformed cursor and out-of-range limit are 400', async () => {
    // Three more POs on top of the earlier ones, all in this warehouse.
    for (let i = 0; i < 3; i += 1) {
      await createPo({
        warehouseId,
        vendorId,
        code: `PO-${ulid().slice(10, 18).toUpperCase()}-${i}`,
        lines: [{ skuId: skuIds.get('INB-B')!, orderedQty: 1, unitCostPaise: 100 }],
      }).expect(201);
    }

    const total = await dbCount('purchase_orders', 'and warehouse_id = $2::uuid', [warehouseId]);
    const seen: string[] = [];
    let nextCursor: string | null = null;
    let guard = 0;
    do {
      const query = nextCursor === null ? '?limit=2' : `?limit=2&cursor=${encodeURIComponent(nextCursor)}`;
      const page = await get(`/warehouses/${warehouseId}/inbound/purchase-orders${query}`).expect(200);
      seen.push(...(page.body.items as { id: string }[]).map((item) => item.id));
      nextCursor = page.body.nextCursor as string | null;
      guard += 1;
    } while (nextCursor !== null && guard < 50);
    expect(nextCursor).toBeNull();
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);

    const bogus = Buffer.from(JSON.stringify({ id: 'not-a-uuid', createdAt: 'nope' })).toString('base64');
    const badCursor = await get(`/warehouses/${warehouseId}/inbound/purchase-orders?cursor=${encodeURIComponent(bogus)}`).expect(400);
    expect(badCursor.body).toMatchObject({ status: 400, code: 'invalid-cursor' });
    await get(`/warehouses/${warehouseId}/inbound/purchase-orders?limit=0`).expect(400);
    await get(`/warehouses/${warehouseId}/inbound/purchase-orders?limit=201`).expect(400);
    await get(`/warehouses/${warehouseId}/inbound/purchase-orders?status=shipped`).expect(400);

    // A non-uuid warehouseId path param is a 400 (the inbound uuid-guard
    // rule), never a 500 from the `::uuid` cast.
    await get('/warehouses/not-a-uuid/inbound/purchase-orders').expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));

    const foreignWarehouse = await get(`/warehouses/${uuidv7()}/inbound/purchase-orders`).expect(404);
    expect(foreignWarehouse.body).toMatchObject({ status: 404, code: 'not-found' });
  });

  it('PO detail errors: an unknown poId is 404; a non-uuid poId is 400; a foreign tenant is 403', async () => {
    await get(`/inbound/purchase-orders/${uuidv7()}`).expect(404)
      .then((res) => expect(res.body).toMatchObject({ code: 'not-found' }));
    await get('/inbound/purchase-orders/not-a-uuid').expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));
    await request(app.getHttpServer())
      .get(`${API}/${uuidv7()}/inbound/purchase-orders/${uuidv7()}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(403)
      .then((res) => expect(res.body).toMatchObject({ code: 'permission-denied' }));
  });

  // ── RLS: cross-tenant isolation on the new tables ─────────────────────────

  it('RLS: a non-superuser session scoped to one tenant sees no vendor/PO rows of another tenant and cannot write foreign rows', async () => {
    // A foreign tenant's PO rows (no FKs — the repo convention).
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    const foreignTenantId = uuidv7();
    try {
      await sql`
        insert into vendors (id, tenant_id, code, name)
        values (${uuidv7()}, ${foreignTenantId}, 'FOREIGN-V', 'Foreign Vendor')`;
      await sql`
        insert into purchase_orders (id, tenant_id, warehouse_id, vendor_id, code, status)
        values (${uuidv7()}, ${foreignTenantId}, ${uuidv7()}, ${uuidv7()}, 'FOREIGN-PO', 'open')`;
      await sql`
        insert into purchase_order_lines (id, tenant_id, po_id, sku_id, ordered_qty, received_qty, unit_cost_paise, status)
        values (${uuidv7()}, ${foreignTenantId}, ${uuidv7()}, ${uuidv7()}, 1, 0, 100, 'open')`;

      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const rls = postgres(url.toString(), { max: 1 });
      try {
        await rls.unsafe(`select set_config('app.tenant_id', '${tenantId}', false)`);
        for (const table of ['vendors', 'purchase_orders', 'purchase_order_lines']) {
          const foreign = await rls.unsafe(
            `select count(*)::int as n from ${table} where tenant_id = '${foreignTenantId}'::uuid`,
          );
          expect(Number((foreign[0] as unknown as { n: number }).n)).toBe(0);
        }
        // Control: scoped to the foreign tenant the rows ARE visible — the
        // isolation, not an empty store, is proven.
        await rls.unsafe(`select set_config('app.tenant_id', '${foreignTenantId}', false)`);
        for (const table of ['vendors', 'purchase_orders', 'purchase_order_lines']) {
          const own = await rls.unsafe(`select count(*)::int as n from ${table}`);
          expect(Number((own[0] as unknown as { n: number }).n)).toBe(1);
        }
        // The write side is fail-closed too: the policy's WITH CHECK rejects
        // an INSERT stamped with a foreign tenant_id.
        await expect(
          rls.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
            await tx`insert into purchase_orders (id, tenant_id, warehouse_id, vendor_id, code, status)
              values (${uuidv7()}, ${foreignTenantId}, ${uuidv7()}, ${uuidv7()}, 'RLS-REJECT', 'open')`;
          }),
        ).rejects.toThrow(/row-level security/i);
      } finally {
        await rls.end();
      }
    } finally {
      await sql.unsafe('set session_replication_role = replica');
      await sql.unsafe(`delete from purchase_order_lines where tenant_id = '${foreignTenantId}'::uuid`);
      await sql.unsafe(`delete from purchase_orders where tenant_id = '${foreignTenantId}'::uuid`);
      await sql.unsafe(`delete from vendors where tenant_id = '${foreignTenantId}'::uuid`);
      await sql.unsafe('set session_replication_role = DEFAULT');
      await sql.end();
    }
  });

  // ── Deployment parity: the hand-appended 0011 CHECKs are DB-enforced ──────

  it('CHECKs on the 0011 tables: a typo status, a non-positive ordered qty, a negative received qty and a negative unit cost are DB-rejected', async () => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const po = await sql`
        select id from purchase_orders where tenant_id = ${tenantId} limit 1`;
      const poId = (po[0] as { id: string }).id;

      await expect(sql`
        update purchase_orders set status = 'shipped' where id = ${poId}
      `).rejects.toThrow(/purchase_orders_status_check/);

      await expect(sql`
        insert into purchase_order_lines (id, tenant_id, po_id, sku_id, ordered_qty, received_qty, unit_cost_paise, status)
        values (${uuidv7()}, ${tenantId}, ${poId}, ${uuidv7()}, 0, 0, 100, 'open')
      `).rejects.toThrow(/purchase_order_lines_ordered_qty_positive/);

      await expect(sql`
        insert into purchase_order_lines (id, tenant_id, po_id, sku_id, ordered_qty, received_qty, unit_cost_paise, status)
        values (${uuidv7()}, ${tenantId}, ${poId}, ${uuidv7()}, 1, -1, 100, 'open')
      `).rejects.toThrow(/purchase_order_lines_received_qty_nonnegative/);

      await expect(sql`
        insert into purchase_order_lines (id, tenant_id, po_id, sku_id, ordered_qty, received_qty, unit_cost_paise, status)
        values (${uuidv7()}, ${tenantId}, ${poId}, ${uuidv7()}, 1, 0, -100, 'open')
      `).rejects.toThrow(/purchase_order_lines_unit_cost_paise_nonnegative/);

      await expect(sql`
        insert into purchase_order_lines (id, tenant_id, po_id, sku_id, ordered_qty, received_qty, unit_cost_paise, status)
        values (${uuidv7()}, ${tenantId}, ${poId}, ${uuidv7()}, 1, 0, 100, 'shipped')
      `).rejects.toThrow(/purchase_order_lines_status_check/);
    } finally {
      await sql.end();
    }
  });
});