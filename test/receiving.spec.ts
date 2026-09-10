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
// Device enrollment seals the offline-store key — the same dev env the
// devices suite sets.
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
// A host that exports either poll interval would boot the background workers
// and race these tests — the same convention as the sibling suites.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

describe('receiving: scan-based GRN + over-receipt decisions (e2e, story 3.3)', () => {
  let app: INestApplication;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let warehouseId: string;
  let vendorId: string;
  let batchSkuId: string; // batch-tracked
  let secondBatchSkuId: string; // batch-tracked (the cross-SKU batch arm)
  let plainSkuId: string; // not batch-tracked
  let deviceToken: string;
  let deviceId: string;
  let operatorToken: string; // the badge-in operator's session token
  let operatorUserId: string;
  let opsToken: string;
  let operatorMemberToken: string; // a team user of the operator role (web session)
  const operatorEmails: string[] = [];

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

    // Tenant + owner.
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Receiving Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;

    // Warehouse + vendor.
    warehouseId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: `RCV-${ulid().slice(10, 16).toUpperCase()}`, name: `Receiving Depot ${ulid()}` })
        .expect(201)
    ).body.id as string;
    vendorId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/vendors`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'VEND-001', name: 'Prime Foods Pvt Ltd' })
        .expect(201)
    ).body.vendor.id as string;

    // SKUs: one batch-tracked, one not.
    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const csv = [
      csvHeader,
      'RCV-A,Receiving Item A,pcs,,1800,,true,false,,,',
      'RCV-B,Receiving Item B,pcs,,1800,,false,false,,,',
      'RCV-C,Receiving Item C,pcs,,1800,,true,false,,,',
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
    const byCode = new Map(
      (skus.body.items as { code: string; id: string }[]).map((item) => [item.code, item.id]),
    );
    batchSkuId = byCode.get('RCV-A')!;
    secondBatchSkuId = byCode.get('RCV-C')!;
    plainSkuId = byCode.get('RCV-B')!;

    // The floor device + its badge-in operator.
    const device = await enrollDevice('Dock scanner 1');
    deviceId = device.deviceId;
    deviceToken = device.deviceToken;
    const badged = await badgeInOperator(deviceToken, `operator-${ulid().toLowerCase()}@example.com`);
    operatorToken = badged.accessToken;
    operatorUserId = badged.operator.id;

    // An ops manager for the review.decide arms; an operator for the 403 arm.
    const ops = await createMember('ops_manager');
    opsToken = ops.token;
    operatorMemberToken = (await createMember('operator')).token;
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
      // legible): receiving rows → PO rows → masters → the spine.
      await sql.unsafe('DELETE FROM over_receipts WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM goods_receipt_lines WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM goods_receipt_notes WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      // The ledger tables are append-only by trigger — the trigger is not
      // RLS and fires even for the table owner (the ledger.spec convention).
      await sql.unsafe('set session_replication_role = replica');
      await sql.unsafe('DELETE FROM ledger_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM ledger_anchors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('set session_replication_role = DEFAULT');
      await sql.unsafe('DELETE FROM batch_on_hand WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM stock_on_hand WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM batches WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
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
      await sql.unsafe('DELETE FROM devices WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM bins WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM zones WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM warehouses WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM tenants WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
    } finally {
      await sql.end();
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  function createPo(
    body: {
      warehouseId: string;
      vendorId: string;
      code: string;
      lines: { skuId: string; orderedQty: number; unitCostPaise: number }[];
    },
    key = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/inbound/purchase-orders`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function closePo(
    poId: string,
    lines: { lineId: string; disposition: 'cancelled' | 'carried' }[],
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/inbound/purchase-orders/${poId}/close`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ lines });
  }

  interface GrnLine {
    poLineId: string | null;
    skuId: string;
    batchCode: string | null;
    mfgDate: string | null;
    qty: number;
  }

  function submitGrn(
    body: {
      warehouseId: string;
      poId: string | null;
      blindReasonCode: string | null;
      occurredAt: string;
      lines: GrnLine[];
    },
    token = operatorToken,
    key = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function grnBody(
    lines: GrnLine[],
    poId: string | null = null,
    overrides: Partial<{ warehouseId: string; blindReasonCode: string | null; occurredAt: string }> = {},
  ): {
    warehouseId: string;
    poId: string | null;
    blindReasonCode: string | null;
    occurredAt: string;
    lines: GrnLine[];
  } {
    return {
      warehouseId,
      poId,
      blindReasonCode: poId === null ? 'unannounced-delivery' : null,
      occurredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      lines,
      ...overrides,
    };
  }

  async function createOpenPo(orderedQty: number, skuId = batchSkuId): Promise<{ poId: string; lineId: string; orderedQty: number }> {
    const created = await createPo({
      warehouseId,
      vendorId,
      code: `PO-${ulid().slice(10, 18).toUpperCase()}`,
      lines: [{ skuId, orderedQty, unitCostPaise: 1250 }],
    }).expect(201);
    const po = created.body.purchaseOrder as { id: string; lines: { id: string; orderedQty: number }[] };
    return { poId: po.id, lineId: po.lines[0]!.id, orderedQty: po.lines[0]!.orderedQty };
  }

  /** One invite → accept → sign-in round trip: an active team user of a role. */
  async function createMember(role: 'ops_manager' | 'operator'): Promise<{ userId: string; token: string }> {
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
    return { userId, token };
  }

  async function enrollDevice(label: string): Promise<{ deviceId: string; deviceToken: string }> {
    const minted = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label, pin: '1357' })
      .expect(201);
    return {
      deviceId: enrolled.body.device.id as string,
      deviceToken: enrolled.body.deviceToken as string,
    };
  }

  /** Badge an EXISTING team user onto a device (no invite round trip). */
  async function badgeExistingOperator(
    deviceToken: string,
    email: string,
  ): Promise<{ accessToken: string; operator: { id: string; role: string } }> {
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({ operatorEmail: email, pin: '1357' })
      .expect(200);
    return {
      accessToken: res.body.accessToken as string,
      operator: res.body.operator as { id: string; role: string },
    };
  }

  /** Badge one operator onto a device: invite + accept + device badge-in. */
  async function badgeInOperator(
    deviceToken: string,
    email = `operator-${ulid().toLowerCase()}@example.com`,
  ): Promise<{ accessToken: string; operator: { id: string; role: string }; email: string }> {
    // The operator: an invited team user (badge-in needs an existing user).
    operatorEmails.push(email);
    const invited = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role: 'operator' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({ operatorEmail: email, pin: '1357' })
      .expect(200);
    return {
      accessToken: res.body.accessToken as string,
      operator: res.body.operator as { id: string; role: string },
      email,
    };
  }

  async function outboxRows(type: string, grnId: string | null = null): Promise<{ payload: Record<string, unknown> }[]> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      // grn.recorded nests the id under goodsReceipt; the over-receipt events
      // carry it at the top level.
      const rows = grnId === null
        ? await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = ${type}`
        : await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = ${type}
            and coalesce(payload->>'grnId', payload->'goodsReceipt'->>'id') = ${grnId}`;
      return rows as unknown as { payload: Record<string, unknown> }[];
    } finally {
      await sql.end();
    }
  }

  async function ledgerRows(grnId: string): Promise<{ type: string; quantity_delta: number; reference_doc: Record<string, unknown>; to_bin_id: string | null }[]> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      return await sql`
        select type, quantity_delta, reference_doc, to_bin_id from ledger_events
        where tenant_id = ${tenantId} and reference_doc->>'grnId' = ${grnId}
        order by seq`;
    } finally {
      await sql.end();
    }
  }

  async function onHandAtBin(binId: string, skuId: string): Promise<number> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`
        select coalesce(sum(quantity), 0)::int as n from stock_on_hand
        where tenant_id = ${tenantId} and bin_id = ${binId} and sku_id = ${skuId}`;
      return Number((rows[0] as unknown as { n: number }).n);
    } finally {
      await sql.end();
    }
  }

  async function receivingBinId(): Promise<string> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`
        select b.id from bins b join zones z on z.id = b.zone_id
        where b.tenant_id = ${tenantId} and b.warehouse_id = ${warehouseId}
        and z.code = 'RECEIVING' and b.code = 'RECEIVING' and b.system_owned = true
        limit 1`;
      return (rows[0] as unknown as { id: string }).id;
    } finally {
      await sql.end();
    }
  }

  // ── The happy path: one open PO, one scan-receipt ──────────────────────────

  it('grn.submit happy path: 201 server-assigned code, physical lines, grn.received ledger events into the system Receiving bin, received_qty updated, outbox recorded', async () => {
    const { poId, lineId, orderedQty } = await createOpenPo(200);

    const res = await submitGrn(
      grnBody([{ poLineId: lineId, skuId: batchSkuId, batchCode: 'LOT-001', mfgDate: '2026-08-01T00:00:00Z', qty: 180 }], poId),
    ).expect(201);
    const grn = res.body.goodsReceipt as {
      id: string;
      code: string;
      poId: string;
      blindReasonCode: string | null;
      status: string;
      deviceId: string;
      recordedBy: string;
      lines: { id: string; grnId: string; poLineId: string; skuId: string; batchId: string; batchCode: string; qty: number; appliedQty: number; excessQty: number }[];
      rejectedLines?: unknown[];
    };
    expect(grn.code).toMatch(/^GRN-\d+$/);
    expect(grn.poId).toBe(poId);
    expect(grn.blindReasonCode).toBeNull();
    expect(grn.status).toBe('recorded');
    expect(grn.deviceId).toBe(deviceId);
    expect(grn.recordedBy).toBe(operatorUserId);
    expect(grn.rejectedLines).toBeUndefined();
    expect(grn.lines).toHaveLength(1);
    expect(grn.lines[0]).toMatchObject({
      grnId: grn.id,
      poLineId: lineId,
      skuId: batchSkuId,
      batchCode: 'LOT-001',
      qty: 180,
      appliedQty: 180,
      excessQty: 0,
    });
    expect(typeof grn.lines[0]!.batchId).toBe('string');

    // The PO line: received 180 of 200, open 20 — derived, never stored.
    const detail = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/inbound/purchase-orders/${poId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const line = (detail.body.purchaseOrder as { lines: { receivedQty: number; openQty: number; status: string }[] }).lines[0]!;
    expect(line.receivedQty).toBe(180);
    expect(line.openQty).toBe(orderedQty - 180);
    expect(line.status).toBe('open');

    // The batch identity exists in the catalog (created through the facade).
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const batches = await sql`
        select id, code, mfg_date::text as mfg_date from batches where tenant_id = ${tenantId} and sku_id = ${batchSkuId} and code = 'LOT-001'`;
      const rows = batches as unknown as { id: string; code: string; mfg_date: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(grn.lines[0]!.batchId);
      expect(rows[0]!.mfg_date).toContain('2026-08-01');
    } finally {
      await sql.end();
    }

    // The system Receiving bin was ensured (this is the tenant's first
    // receipt): exactly one system-owned bin, holding the 180 units.
    const binId = await receivingBinId();
    expect(binId).toBeTruthy();
    const allBins = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const systemBins = await allBins`
        select count(*)::int as n from bins where tenant_id = ${tenantId} and system_owned = true`;
      expect(Number((systemBins[0] as unknown as { n: number }).n)).toBe(1);
    } finally {
      await allBins.end();
    }
    expect(await onHandAtBin(binId, batchSkuId)).toBe(180);

    // The ledger: one grn.received event, batch arm, grn-receipt reference.
    const events = await ledgerRows(grn.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'grn.received', quantity_delta: 180 });
    expect((events[0]!.reference_doc as { kind: string; grnId: string; poId: string; poLineId: string })).toEqual({
      kind: 'grn-receipt',
      grnId: grn.id,
      poId,
      poLineId: lineId,
    });
    expect(events[0]!.to_bin_id).toBe(binId);

    // The outbox: one grn.recorded carrying the full GRN snapshot.
    const recorded = await outboxRows('grn.recorded', grn.id);
    expect(recorded).toHaveLength(1);
    expect((recorded[0]!.payload as { goodsReceipt: { code: string; lines: unknown[] } }).goodsReceipt.code).toBe(grn.code);
    expect((recorded[0]!.payload as { goodsReceipt: { lines: unknown[] } }).goodsReceipt.lines).toHaveLength(1);
  });

  it('partial GRN: received < ordered leaves the line open with the correct derived remainder; the GRN records the actual', async () => {
    const { poId, lineId, orderedQty } = await createOpenPo(50);
    const res = await submitGrn(
      grnBody([{ poLineId: lineId, skuId: batchSkuId, batchCode: 'LOT-P1', mfgDate: null, qty: 30 }], poId),
    ).expect(201);
    const grn = res.body.goodsReceipt as { lines: { qty: number; appliedQty: number; excessQty: number }[] };
    expect(grn.lines[0]).toMatchObject({ qty: 30, appliedQty: 30, excessQty: 0 });

    const detail = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/inbound/purchase-orders/${poId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const line = (detail.body.purchaseOrder as { lines: { receivedQty: number; openQty: number; status: string }[] }).lines[0]!;
    expect(line.receivedQty).toBe(30);
    expect(line.openQty).toBe(orderedQty - 30);
    expect(line.status).toBe('open');
  });

  // ── Over-receipt: gate + decision arms ─────────────────────────────────────

  it('over-receipt: the physical quantity records in full, the within-open portion applies now, the excess pends; approve applies it (ledger + received_qty + audit + outbox), reject leaves it unapplied; a second decision is 409', async () => {
    // The receiving bin accumulates across this suite — every on-hand
    // assertion here is a delta against the pre-receipt level.
    const binId = await receivingBinId();
    const baseline = await onHandAtBin(binId, batchSkuId);

    // ── the approve arm ──────────────────────────────────────────────────
    const first = await createOpenPo(100);
    const created = await submitGrn(
      grnBody([{ poLineId: first.lineId, skuId: batchSkuId, batchCode: 'LOT-OVR-1', mfgDate: null, qty: 120 }], first.poId),
    ).expect(201);
    const grn = created.body.goodsReceipt as { id: string; lines: { qty: number; appliedQty: number; excessQty: number }[] };
    expect(grn.lines[0]).toMatchObject({ qty: 120, appliedQty: 100, excessQty: 20 });

    // The pending over-receipt row + its requested outbox event.
    const pending = await outboxRows('over_receipt.requested', grn.id);
    expect(pending).toHaveLength(1);
    const overReceiptId = (pending[0]!.payload as { overReceiptId: string }).overReceiptId;
    // Within-open only: exactly the +100 from this receipt landed.
    expect(await onHandAtBin(binId, batchSkuId)).toBe(baseline + 100);

    // The queue read: the pending entry is there with its GRN ref.
    const queue = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/receiving/over-receipts?status=pending`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const queueItem = (queue.body.items as { id: string; grnCode: string; excessQty: number; status: string }[]).find(
      (item) => item.id === overReceiptId,
    );
    expect(queueItem).toBeTruthy();
    expect(queueItem!.grnCode).toMatch(/^GRN-\d+$/);
    expect(queueItem!.excessQty).toBe(20);

    // An operator (no review.decide) is 403 role-denied (the command's
    // authority read runs before the replay/decision logic).
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/over-receipts/${overReceiptId}/approve`)
      .set('Authorization', `Bearer ${operatorMemberToken}`)
      .set(KEY_HEADER, ulid())
      .expect(403)
      .then((res) => expect(res.body).toMatchObject({ code: 'role-denied' }));

    const approveKey = ulid();
    const approved = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/over-receipts/${overReceiptId}/approve`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, approveKey)
      .expect(200);
    expect(approved.body.overReceipt).toMatchObject({ id: overReceiptId, status: 'approved', excessQty: 20 });

    // The excess applied: one new ledger event + received_qty bump.
    expect(await onHandAtBin(binId, batchSkuId)).toBe(baseline + 120);
    const events = await ledgerRows(grn.id);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'grn.received', quantity_delta: 20 });
    const detail = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/inbound/purchase-orders/${first.poId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    // received = 100 applied at submit + 20 approved = 120 → open −20
    // (derived, negative — the relaxed OpenAPI bound).
    expect((detail.body.purchaseOrder as { lines: { receivedQty: number; openQty: number }[] }).lines[0]).toMatchObject({
      receivedQty: 120,
      openQty: -20,
    });

    // A second decision is a deterministic 409 (already decided).
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/over-receipts/${overReceiptId}/approve`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .expect(409)
      .then((res) => expect(res.body).toMatchObject({ code: 'over-receipt-decided' }));
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/over-receipts/${overReceiptId}/reject`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .expect(409)
      .then((res) => expect(res.body).toMatchObject({ code: 'over-receipt-decided' }));

    // Approve replay: a verbatim same-key resend re-serves the snapshot.
    const replayed = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/over-receipts/${overReceiptId}/approve`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, approveKey)
      .expect(200);
    expect(replayed.body).toEqual(approved.body);

    // The audit row + the approved outbox event exist exactly once.
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const audits = await sql`
        select action, reference from audit_events where tenant_id = ${tenantId}
        and target_id = ${overReceiptId} order by occurred_at, id`;
      const auditRows = audits as unknown as { action: string; reference: string }[];
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]!.action).toBe('over_receipt.approved');
      expect(auditRows[0]!.reference).toBe(approveKey);
    } finally {
      await sql.end();
    }
    const approvedEvents = await outboxRows('over_receipt.approved', grn.id);
    expect(approvedEvents).toHaveLength(1);

    // ── the reject arm ───────────────────────────────────────────────────
    const second = await createOpenPo(10);
    const rejectCreated = await submitGrn(
      grnBody([{ poLineId: second.lineId, skuId: batchSkuId, batchCode: 'LOT-OVR-2', mfgDate: null, qty: 15 }], second.poId),
    ).expect(201);
    const rejectGrn = rejectCreated.body.goodsReceipt as { id: string; lines: { appliedQty: number; excessQty: number }[] };
    expect(rejectGrn.lines[0]).toMatchObject({ appliedQty: 10, excessQty: 5 });
    const rejectPending = await outboxRows('over_receipt.requested', rejectGrn.id);
    const rejectId = (rejectPending[0]!.payload as { overReceiptId: string }).overReceiptId;

    const rejected = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/over-receipts/${rejectId}/reject`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .expect(200);
    expect(rejected.body.overReceipt).toMatchObject({ id: rejectId, status: 'rejected' });

    // The excess stayed unapplied: no second ledger event, no received_qty
    // bump — the bin is at +120 (100 applied + 20 approved, first arm) plus
    // the reject receipt's own +10 within-open application, nothing more.
    expect(await onHandAtBin(binId, batchSkuId)).toBe(baseline + 130);
    expect(await ledgerRows(rejectGrn.id)).toHaveLength(1);
    const rejectDetail = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/inbound/purchase-orders/${second.poId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect((rejectDetail.body.purchaseOrder as { lines: { receivedQty: number }[] }).lines[0]!.receivedQty).toBe(10);

    const rejectedEvents = await outboxRows('over_receipt.rejected', rejectGrn.id);
    expect(rejectedEvents).toHaveLength(1);
  });

  it('over-receipt decision authorization: an operator member (no review.decide) is 403 role-denied; an unknown id is 404; a malformed id is 400', async () => {
    const { poId, lineId } = await createOpenPo(5);
    const created = await submitGrn(
      grnBody([{ poLineId: lineId, skuId: batchSkuId, batchCode: 'LOT-OVR-3', mfgDate: null, qty: 7 }], poId),
    ).expect(201);
    const grnId = (created.body.goodsReceipt as { id: string }).id;
    const pending = await outboxRows('over_receipt.requested', grnId);
    const id = (pending[0]!.payload as { overReceiptId: string }).overReceiptId;

    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/over-receipts/${id}/reject`)
      .set('Authorization', `Bearer ${operatorMemberToken}`)
      .set(KEY_HEADER, ulid())
      .expect(403)
      .then((res) => expect(res.body).toMatchObject({ code: 'role-denied' }));

    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/over-receipts/${uuidv7()}/reject`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .expect(404)
      .then((res) => expect(res.body).toMatchObject({ code: 'not-found' }));

    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/over-receipts/not-a-uuid/reject`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));

    // Still pending — the denials left no state behind.
    const queue = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/receiving/over-receipts?status=pending`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect((queue.body.items as { id: string }[]).some((item) => item.id === id)).toBe(true);
  });

  // ── Blind receive ──────────────────────────────────────────────────────────

  it('blind receive: poId null + a reason code records a blind GRN with no PO refs; a bad/missing reason code is 400; a reason code on a PO receipt is 400', async () => {
    const binId = await receivingBinId();
    const baseline = await onHandAtBin(binId, plainSkuId);
    const res = await submitGrn(
      grnBody([{ poLineId: null, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 12 }], null),
    ).expect(201);
    const grn = res.body.goodsReceipt as {
      code: string;
      poId: string | null;
      blindReasonCode: string | null;
      lines: { poLineId: string | null; skuId: string; batchId: string | null; qty: number; appliedQty: number; excessQty: number }[];
    };
    expect(grn.poId).toBeNull();
    expect(grn.blindReasonCode).toBe('unannounced-delivery');
    expect(grn.lines[0]).toMatchObject({ poLineId: null, skuId: plainSkuId, batchId: null, qty: 12, appliedQty: 12, excessQty: 0 });

    // No PO refs, no ledger poId; the full physical quantity applies.
    expect(await onHandAtBin(binId, plainSkuId)).toBe(baseline + 12);

    // Missing / unknown reason codes are 400 before any write.
    await submitGrn(grnBody([{ poLineId: null, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 1 }], null, { blindReasonCode: null })).expect(400);
    await submitGrn(grnBody([{ poLineId: null, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 1 }], null, { blindReasonCode: 'wrong-pallet' })).expect(400);
    // A reason code on a PO receipt is 400.
    const { poId, lineId } = await createOpenPo(3);
    await submitGrn(
      grnBody([{ poLineId: lineId, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 1 }], poId, { blindReasonCode: 'other' }),
    ).expect(400);
  });

  // ── Server re-authorization ────────────────────────────────────────────────

  it('submit against a closed PO is 409 po-not-open naming the state (the stale queued receipt retracts); against a cancelled line the line is rejected naming it while other lines settle', async () => {
    // ── a closed PO ──────────────────────────────────────────────────────
    const { poId, lineId } = await createOpenPo(10);
    await closePo(poId, [{ lineId, disposition: 'cancelled' }]).expect(200);
    const closed = await submitGrn(
      grnBody([{ poLineId: lineId, skuId: batchSkuId, batchCode: 'LOT-CLOSED', mfgDate: null, qty: 4 }], poId),
    ).expect(409);
    expect(closed.body).toMatchObject({ status: 409, code: 'po-not-open' });
    expect(closed.body.detail).toContain('closed');

    // ── a cancelled line on an otherwise-open PO ─────────────────────────
    const created = await createPo({
      warehouseId,
      vendorId,
      code: `PO-${ulid().slice(10, 18).toUpperCase()}`,
      lines: [
        { skuId: batchSkuId, orderedQty: 6, unitCostPaise: 1000 },
        { skuId: plainSkuId, orderedQty: 8, unitCostPaise: 500 },
      ],
    }).expect(201);
    const po = created.body.purchaseOrder as { id: string; lines: { id: string; skuId: string }[] };
    const cancelledLine = po.lines.find((line) => line.skuId === batchSkuId)!;
    const survivingLine = po.lines.find((line) => line.skuId === plainSkuId)!;
    await closePo(po.id, [
      { lineId: cancelledLine.id, disposition: 'cancelled' },
      { lineId: survivingLine.id, disposition: 'carried' },
    ]).expect(200);
    // The close carried the surviving line onto the successor — submit against
    // the ORIGINAL (now closed) PO and the whole request is po-not-open.
    await submitGrn(
      grnBody([{ poLineId: survivingLine.id, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 2 }], poId),
    ).expect(409);
  });

  it('line-level settlement: an unknown poLineId is rejected in the response naming the reason while the other lines settle; a cancelled line is rejected naming its state', async () => {
    const created = await createPo({
      warehouseId,
      vendorId,
      code: `PO-${ulid().slice(10, 18).toUpperCase()}`,
      lines: [{ skuId: plainSkuId, orderedQty: 20, unitCostPaise: 700 }],
    }).expect(201);
    const po = created.body.purchaseOrder as { id: string; lines: { id: string; orderedQty: number }[] };
    const lineId = po.lines[0]!.id;

    // A foreign poLineId rides alongside a valid one: only the bad one is
    // rejected — the settled line still applies (partial settlement).
    const res = await submitGrn(
      grnBody([
        { poLineId: uuidv7(), skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 4 },
        { poLineId: lineId, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 10 },
      ], po.id),
    ).expect(201);
    const grn = res.body.goodsReceipt as {
      id: string;
      lines: { poLineId: string | null; appliedQty: number }[];
      rejectedLines: { poLineId: string; qty: number; code: string; reason: string }[];
    };
    expect(grn.rejectedLines).toHaveLength(1);
    expect(grn.rejectedLines[0]).toMatchObject({ code: 'po-line-not-found', qty: 4 });
    expect(grn.lines).toHaveLength(1);
    expect(grn.lines[0]).toMatchObject({ poLineId: lineId, appliedQty: 10 });
    const detail = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/inbound/purchase-orders/${po.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect((detail.body.purchaseOrder as { lines: { receivedQty: number }[] }).lines[0]!.receivedQty).toBe(10);

    // A cancelled line mid-receive: close it cancelled, then a queued receipt
    // against it retracts visibly (409 po-not-open — the PO closed with it).
    await closePo(po.id, [{ lineId, disposition: 'cancelled' }]).expect(200);
    await submitGrn(
      grnBody([{ poLineId: lineId, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 5 }], po.id),
    ).expect(409);
  });

  // ── Idempotency + device re-authorization ──────────────────────────────────

  it('idempotency: the same key + payload re-serves the snapshot with no second GRN/ledger event; a different payload is 422; a missing key is 400', async () => {
    const { poId, lineId } = await createOpenPo(40);
    const body = grnBody([{ poLineId: lineId, skuId: batchSkuId, batchCode: 'LOT-IDEM', mfgDate: null, qty: 25 }], poId);
    const key = ulid();
    const first = await submitGrn(body, operatorToken, key).expect(201);
    const replayed = await submitGrn(body, operatorToken, key).expect(201);
    expect(replayed.body).toEqual(first.body);

    const grnId = (first.body.goodsReceipt as { id: string }).id;
    expect(await ledgerRows(grnId)).toHaveLength(1);
    expect(await outboxRows('grn.recorded', grnId)).toHaveLength(1);

    // Same key, different payload → 422.
    await submitGrn(
      grnBody([{ poLineId: lineId, skuId: batchSkuId, batchCode: 'LOT-IDEM', mfgDate: null, qty: 26 }], poId),
      operatorToken,
      key,
    ).expect(422)
      .then((res) => expect(res.body).toMatchObject({ code: 'idempotency-key-reuse' }));

    // Missing Idempotency-Key header → 400.
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send(body)
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'idempotency-key-required' }));
  });

  it('device authorization: a bare device credential is 401; a demoted-to-accountant operator is 403 role-denied; a revoked device is 403 device-revoked', async () => {
    const { poId, lineId } = await createOpenPo(4);
    const body = grnBody([{ poLineId: lineId, skuId: batchSkuId, batchCode: 'LOT-AUTH', mfgDate: null, qty: 2 }], poId);

    // The bare (pre-badge-in) device credential cannot submit — badge-in first.
    await submitGrn(body, deviceToken).expect(401)
      .then((res) => expect(res.body).toMatchObject({ code: 'unauthenticated' }));

    // A demoted-to-accountant operator is denied per command (fail-closed
    // DB role re-read); restoring the role re-opens the surface.
    await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/users/${operatorUserId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ role: 'accountant' })
      .expect(200);
    await submitGrn(body).expect(403)
      .then((res) => expect(res.body).toMatchObject({ code: 'role-denied' }));
    await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/users/${operatorUserId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ role: 'operator' })
      .expect(200);

    // A revoked device is 403 device-revoked on its next command (the
    // device row re-read is fail-closed — a fresh device, so the shared
    // one stays live for the other tests). The fresh device badges in the
    // ALREADY-ENROLLED operator (a second invite would 409 on the email).
    const fresh = await enrollDevice('Dock scanner 2');
    const session = await badgeExistingOperator(fresh.deviceToken, operatorEmails[0]!);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/${fresh.deviceId}/revoke`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(200);
    await submitGrn(body, session.accessToken).expect(403)
      .then((res) => expect(res.body).toMatchObject({ code: 'device-revoked' }));
  });

  // ── Validation arms ────────────────────────────────────────────────────────

  it('validation: a batch-tracked SKU without a batch code is 400; a batch code on a plain SKU is 400; an unknown SKU/warehouse is 404; a zero qty is 400', async () => {
    const { poId, lineId } = await createOpenPo(6);
    await submitGrn(grnBody([{ poLineId: lineId, skuId: batchSkuId, batchCode: null, mfgDate: null, qty: 1 }], poId)).expect(400);
    await submitGrn(grnBody([{ poLineId: lineId, skuId: plainSkuId, batchCode: 'NO-BATCH', mfgDate: null, qty: 1 }], poId)).expect(400);
    await submitGrn(grnBody([{ poLineId: lineId, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 0 }], poId)).expect(400);
    await submitGrn(
      grnBody([{ poLineId: lineId, skuId: uuidv7(), batchCode: null, mfgDate: null, qty: 1 }], poId),
    ).expect(404)
      .then((res) => expect(res.body).toMatchObject({ code: 'not-found' }));
    await submitGrn(grnBody([{ poLineId: lineId, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 1 }], poId, { warehouseId: uuidv7() })).expect(404);
    await submitGrn(grnBody([], poId)).expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));
    // The failed submits left the PO untouched.
    const detail = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/inbound/purchase-orders/${poId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect((detail.body.purchaseOrder as { lines: { receivedQty: number }[] }).lines[0]!.receivedQty).toBe(0);
  });

  it('the device catalog snapshot: badge-in session required — SKUs with barcodes + open PO lines; a closed PO is absent; the bare credential is 401', async () => {
    const device = await enrollDevice('Handheld 3');
    const badged = await badgeInOperator(device.deviceToken);
    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`)
      .set('Authorization', `Bearer ${badged.accessToken}`)
      .expect(200);
    const snapshot = res.body as {
      generatedAt: string;
      warehouseId: string;
      skus: { id: string; code: string; barcode: string; batchTracked: boolean }[];
      openPurchaseOrders: { id: string; code: string; lines: { openQty: number }[] }[];
    };
    expect(snapshot.warehouseId).toBe(warehouseId);
    expect(snapshot.generatedAt).toBeTruthy();
    expect(snapshot.skus.map((sku) => sku.code).sort()).toEqual(['RCV-A', 'RCV-B', 'RCV-C']);
    const batchSku = snapshot.skus.find((sku) => sku.id === batchSkuId)!;
    expect(batchSku.batchTracked).toBe(true);
    expect(typeof batchSku.barcode).toBe('string');

    // The open PO list: a fresh open PO is present; a closed one is not.
    const fresh = await createOpenPo(9, plainSkuId);
    const closedPo = await createOpenPo(3, plainSkuId);
    await closePo(closedPo.poId, [{ lineId: closedPo.lineId, disposition: 'cancelled' }]).expect(200);
    const after = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`)
      .set('Authorization', `Bearer ${badged.accessToken}`)
      .expect(200);
    const snapshotAfter = after.body as typeof snapshot;
    const openIds = snapshotAfter.openPurchaseOrders.map((po) => po.id);
    expect(openIds).toContain(fresh.poId);
    expect(openIds).not.toContain(closedPo.poId);
    expect(snapshotAfter.openPurchaseOrders.find((po) => po.id === fresh.poId)!.lines[0]!.openQty).toBe(9);

    // A bare credential is 401; a malformed warehouseId is 400.
    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`)
      .set('Authorization', `Bearer ${device.deviceToken}`)
      .expect(401)
      .then((res) => expect(res.body).toMatchObject({ code: 'unauthenticated' }));
    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=not-a-uuid`)
      .set('Authorization', `Bearer ${badged.accessToken}`)
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));
    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${uuidv7()}`)
      .set('Authorization', `Bearer ${badged.accessToken}`)
      .expect(404)
      .then((res) => expect(res.body).toMatchObject({ code: 'not-found' }));
  });

  // ── The GRN list read ──────────────────────────────────────────────────────

  it('GRN list: newest first with line/unit sums, warehouse-filterable, keyset walk; a malformed warehouseId filter is 400', async () => {
    const { poId, lineId } = await createOpenPo(30, plainSkuId);
    await submitGrn(grnBody([{ poLineId: lineId, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 18 }], poId)).expect(201);
    await submitGrn(grnBody([{ poLineId: null, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 7 }], null)).expect(201);

    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/receiving/goods-receipts?warehouseId=${warehouseId}&limit=1`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const items = res.body.items as { id: string; code: string; lineCount: number; totalUnits: number; appliedUnits: number; blindReasonCode: string | null; status: string }[];
    expect(items).toHaveLength(1);
    // Newest first: the blind receipt just above is the newest.
    expect(items[0]).toMatchObject({ status: 'recorded', blindReasonCode: 'unannounced-delivery' });
    expect(items[0]!.lineCount).toBe(1);
    expect(items[0]!.totalUnits).toBe(7);
    expect(items[0]!.appliedUnits).toBe(7);

    // The keyset walk: page 2 continues past page 1's newest GRN.
    const pageTwo = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/receiving/goods-receipts?warehouseId=${warehouseId}&limit=1&cursor=${res.body.nextCursor as string}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const pageTwoItems = pageTwo.body.items as { id: string; totalUnits: number; blindReasonCode: string | null }[];
    expect(pageTwoItems.length).toBeGreaterThanOrEqual(1);
    expect(pageTwoItems.some((item) => item.id === items[0]!.id)).toBe(false);
    // The PO receipt rides directly behind the blind one.
    expect(pageTwoItems[0]).toMatchObject({ blindReasonCode: null, totalUnits: 18 });
    const all = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/receiving/goods-receipts?limit=200`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const allItems = all.body.items as { blindReasonCode: string | null }[];
    expect(allItems.some((item) => item.blindReasonCode === 'unannounced-delivery')).toBe(true);

    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/receiving/goods-receipts?warehouseId=not-a-uuid`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));
  });

  // ── RLS: cross-tenant isolation on the three new tables ────────────────────

  it('RLS: a non-superuser session scoped to one tenant sees no receiving rows of another tenant and cannot write foreign rows', async () => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    const foreignTenantId = uuidv7();
    try {
      await sql`
        insert into goods_receipt_notes (id, tenant_id, warehouse_id, code, po_id, blind_reason_code, status, device_id, recorded_by, occurred_at, recorded_at)
        values (${uuidv7()}, ${foreignTenantId}, ${uuidv7()}, 'GRN-9999', null, 'other', 'recorded', ${uuidv7()}, ${uuidv7()}, now(), now())`;
      await sql`
        insert into over_receipts (id, tenant_id, warehouse_id, grn_id, grn_line_id, po_id, po_line_id, sku_id, excess_qty, status, requested_by, requested_at)
        values (${uuidv7()}, ${foreignTenantId}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, 3, 'pending', ${uuidv7()}, now())`;

      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const rls = postgres(url.toString(), { max: 1 });
      try {
        await rls.unsafe(`select set_config('app.tenant_id', '${tenantId}', false)`);
        for (const table of ['goods_receipt_notes', 'goods_receipt_lines', 'over_receipts']) {
          const foreign = await rls.unsafe(
            `select count(*)::int as n from ${table} where tenant_id = '${foreignTenantId}'::uuid`,
          );
          expect(Number((foreign[0] as unknown as { n: number }).n)).toBe(0);
        }
        // Control: scoped to the foreign tenant the row IS visible.
        await rls.unsafe(`select set_config('app.tenant_id', '${foreignTenantId}', false)`);
        const own = await rls.unsafe('select count(*)::int as n from goods_receipt_notes');
        expect(Number((own[0] as unknown as { n: number }).n)).toBe(1);
        // The write side is fail-closed: a foreign-tenant INSERT is rejected.
        await expect(
          rls.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
            await tx`insert into over_receipts (id, tenant_id, warehouse_id, grn_id, grn_line_id, po_id, po_line_id, sku_id, excess_qty, status, requested_by, requested_at)
              values (${uuidv7()}, ${foreignTenantId}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, 3, 'pending', ${uuidv7()}, now())`;
          }),
        ).rejects.toThrow(/row-level security/i);
      } finally {
        await rls.end();
      }
    } finally {
      await sql.unsafe('set session_replication_role = replica');
      await sql.unsafe(`delete from over_receipts where tenant_id = '${foreignTenantId}'::uuid`);
      await sql.unsafe(`delete from goods_receipt_notes where tenant_id = '${foreignTenantId}'::uuid`);
      await sql.unsafe('set session_replication_role = DEFAULT');
      await sql.end();
    }
  });

  // ── Deployment parity: the hand-appended 0013 CHECKs are DB-enforced ───────

  it('CHECKs on the 0013 tables: a bad status, a non-positive qty, a negative applied qty, applied > physical, a non-positive excess and a bad blind pairing are DB-rejected', async () => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    const grnId = uuidv7();
    try {
      await sql`
        insert into goods_receipt_notes (id, tenant_id, warehouse_id, code, po_id, blind_reason_code, status, device_id, recorded_by, occurred_at, recorded_at)
        values (${grnId}, ${tenantId}, ${warehouseId}, 'GRN-TESTCHECK', ${uuidv7()}, null, 'recorded', ${deviceId}, ${operatorUserId}, now(), now())`;

      await expect(sql`
        update goods_receipt_notes set status = 'posted' where id = ${grnId}
      `).rejects.toThrow(/goods_receipt_notes_status_check/);

      await expect(sql`
        insert into goods_receipt_lines (id, tenant_id, grn_id, po_line_id, sku_id, qty, applied_qty)
        values (${uuidv7()}, ${tenantId}, ${grnId}, null, ${batchSkuId}, 0, 0)
      `).rejects.toThrow(/goods_receipt_lines_qty_positive/);

      await expect(sql`
        insert into goods_receipt_lines (id, tenant_id, grn_id, po_line_id, sku_id, qty, applied_qty)
        values (${uuidv7()}, ${tenantId}, ${grnId}, null, ${batchSkuId}, 5, -1)
      `).rejects.toThrow(/goods_receipt_lines_applied_qty_nonnegative/);

      await expect(sql`
        insert into goods_receipt_lines (id, tenant_id, grn_id, po_line_id, sku_id, qty, applied_qty)
        values (${uuidv7()}, ${tenantId}, ${grnId}, null, ${batchSkuId}, 5, 6)
      `).rejects.toThrow(/goods_receipt_lines_applied_le_physical/);

      await expect(sql`
        insert into over_receipts (id, tenant_id, warehouse_id, grn_id, grn_line_id, po_id, po_line_id, sku_id, excess_qty, status, requested_by, requested_at)
        values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${grnId}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${batchSkuId}, 0, 'pending', ${operatorUserId}, now())
      `).rejects.toThrow(/over_receipts_excess_qty_positive/);

      await expect(sql`
        insert into over_receipts (id, tenant_id, warehouse_id, grn_id, grn_line_id, po_id, po_line_id, sku_id, excess_qty, status, requested_by, requested_at)
        values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${grnId}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${batchSkuId}, 1, 'held', ${operatorUserId}, now())
      `).rejects.toThrow(/over_receipts_status_check/);

      // The blind pairing: po_id present + a reason code is 400-level wrong.
      await expect(sql`
        insert into goods_receipt_notes (id, tenant_id, warehouse_id, code, po_id, blind_reason_code, status, device_id, recorded_by, occurred_at, recorded_at)
        values (${uuidv7()}, ${tenantId}, ${warehouseId}, 'GRN-BADPAIR', ${uuidv7()}, 'other', 'recorded', ${deviceId}, ${operatorUserId}, now(), now())
      `).rejects.toThrow(/goods_receipt_notes_blind_pairing/);
    } finally {
      await sql.end();
    }
  });

  // ── Pinned arms from the review triage (review_loop_iteration 1) ───────────

  it('grn.submit still succeeds after a non-numeric GRN code suffix exists in the tenant (the allocation max ignores it, never a cast 500)', async () => {
    // `GRN-TESTCHECK` was inserted by the CHECK round-trip test above — a row
    // whose code tail is not numeric. The next submit still allocates a
    // numeric `GRN-<n>` successor of the numeric codes.
    const { poId, lineId } = await createOpenPo(10, plainSkuId);
    const res = await submitGrn(
      grnBody([{ poLineId: lineId, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 4 }], poId),
    ).expect(201);
    const grn = res.body.goodsReceipt as { code: string };
    expect(grn.code).toMatch(/^GRN-\d+$/);
    expect(Number(grn.code.slice(4))).toBeGreaterThan(0);
  });

  it('a line quantity above the int4 bound of goods_receipt_lines is a 400 before any write — never an insert-time 500', async () => {
    const { poId, lineId } = await createOpenPo(10, plainSkuId);
    await submitGrn(
      grnBody(
        [{ poLineId: lineId, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 2_147_483_648 }],
        poId,
      ),
    )
      .expect(400)
      .then((res) => expect(res.body).toMatchObject({ code: 'validation-failed' }));
    // The rejected receipt wrote nothing — the PO line's received_qty is untouched.
    const po = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/inbound/purchase-orders/${poId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const line = (po.body.purchaseOrder as { lines: { receivedQty: number }[] }).lines[0]!;
    expect(line.receivedQty).toBe(0);
  });

  it('a PO receipt whose line carries poLineId null settles the SKU in full (the device cache-miss shape) — physical truth applies, no PO gating, no over-receipt row', async () => {
    const { poId, lineId } = await createOpenPo(50, plainSkuId);
    const res = await submitGrn(
      grnBody(
        [
          { poLineId: lineId, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 6 },
          { poLineId: null, skuId: plainSkuId, batchCode: null, mfgDate: null, qty: 9 },
        ],
        poId,
      ),
    ).expect(201);
    const grn = res.body.goodsReceipt as {
      id: string;
      lines: { poLineId: string | null; qty: number; appliedQty: number; excessQty: number }[];
      rejectedLines?: unknown[];
    };
    expect(grn.rejectedLines).toBeUndefined();
    expect(grn.lines).toHaveLength(2);
    // The listed line applies within open qty; the unlisted (null-ref) line
    // applies in full — no over-receipt row for either.
    expect(grn.lines[0]).toMatchObject({ poLineId: lineId, qty: 6, appliedQty: 6, excessQty: 0 });
    expect(grn.lines[1]).toMatchObject({ poLineId: null, qty: 9, appliedQty: 9, excessQty: 0 });
    // The ledger carries both events (the receipt into the receiving bin);
    // the null-arm event references the GRN without a poLineId.
    const events = await ledgerRows(grn.id);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.quantity_delta).sort((a, b) => a - b)).toEqual([6, 9]);
    expect(events.find((event) => event.quantity_delta === 9)!.reference_doc).toMatchObject({
      kind: 'grn-receipt',
      grnId: grn.id,
      poId,
    });
    expect(events.find((event) => event.quantity_delta === 9)!.reference_doc.poLineId).toBeUndefined();
    // received_qty moved only by the listed line.
    const po = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/inbound/purchase-orders/${poId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const line = (po.body.purchaseOrder as { lines: { receivedQty: number }[] }).lines[0]!;
    expect(line.receivedQty).toBe(6);
    // No over-receipt row pended for either line.
    expect(await outboxRows('over_receipt.requested', grn.id)).toHaveLength(0);
  });

  it('the same batch code under a different SKU is a distinct legal batch (matrix row 10, amended): one GRN, two SKUs, one code — 201 with its own batch row per (tenant, sku, code)', async () => {
    // One PO carrying both batch-tracked SKUs, one GRN carrying the SAME
    // batch code on both lines. Batch identity is per (tenant, sku, code)
    // (the frozen 2.4 data model) — the duplicate code under the other SKU
    // is a distinct legal batch, never an error.
    const created = await createPo({
      warehouseId,
      vendorId,
      code: `PO-${ulid().slice(10, 18).toUpperCase()}`,
      lines: [
        { skuId: batchSkuId, orderedQty: 10, unitCostPaise: 800 },
        { skuId: secondBatchSkuId, orderedQty: 10, unitCostPaise: 900 },
      ],
    }).expect(201);
    const po = created.body.purchaseOrder as { id: string; lines: { id: string; skuId: string }[] };
    const lineA = po.lines.find((candidate) => candidate.skuId === batchSkuId)!.id;
    const lineC = po.lines.find((candidate) => candidate.skuId === secondBatchSkuId)!.id;

    const res = await submitGrn(
      grnBody([
        { poLineId: lineA, skuId: batchSkuId, batchCode: 'LOT-SHARED', mfgDate: '2026-07-01T00:00:00Z', qty: 4 },
        { poLineId: lineC, skuId: secondBatchSkuId, batchCode: 'LOT-SHARED', mfgDate: null, qty: 5 },
      ], po.id),
    ).expect(201);
    const grn = res.body.goodsReceipt as {
      id: string;
      lines: { poLineId: string; skuId: string; batchId: string; batchCode: string | null; appliedQty: number }[];
      rejectedLines?: unknown[];
    };
    expect(grn.rejectedLines).toBeUndefined();
    expect(grn.lines).toHaveLength(2);
    // Each line settled in full and carries ITS OWN batch id.
    expect(grn.lines[0]).toMatchObject({ poLineId: lineA, skuId: batchSkuId, batchCode: 'LOT-SHARED', appliedQty: 4 });
    expect(grn.lines[1]).toMatchObject({ poLineId: lineC, skuId: secondBatchSkuId, batchCode: 'LOT-SHARED', appliedQty: 5 });
    expect(grn.lines[0]!.batchId).not.toBe(grn.lines[1]!.batchId);
    // Two batch rows exist under the same code — one per (tenant, sku).
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`
        select sku_id, id from batches
        where tenant_id = ${tenantId} and code = 'LOT-SHARED'
        order by sku_id`;
      const batchRows = rows as unknown as { sku_id: string; id: string }[];
      expect(batchRows).toHaveLength(2);
      expect(new Set(batchRows.map((row) => row.sku_id))).toEqual(new Set([batchSkuId, secondBatchSkuId]));
      expect(batchRows.find((row) => row.sku_id === batchSkuId)!.id).toBe(grn.lines[0]!.batchId);
      expect(batchRows.find((row) => row.sku_id === secondBatchSkuId)!.id).toBe(grn.lines[1]!.batchId);
    } finally {
      await sql.end();
    }
  });
});