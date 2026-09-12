import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

// The e2e suite talks to the real Postgres (docker-compose dev DB by
// default; CI provides the service container) and signs sessions.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
// A host that exports either poll interval would boot the background workers
// and race these tests — the same convention as the sibling suites.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;

const API = '/api/v1/tenants';
/** The invitee's own password (set at accept-invite, spec 1.5). */
const INVITEE_PASSWORD = 'team-member-password';
const KEY_HEADER = 'Idempotency-Key';

/** Day-scale helper for mfg/expiry instants relative to the test clock. */
function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

describe('batch and serial traceability (e2e, story 2.4)', () => {
  let app: INestApplication;
  let facade: InventoryFacade;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let warehouseId: string;
  let binA: string;
  let binB: string;
  const skuIds = new Map<string, string>();

  let suiteDb: SuiteDatabase;

  beforeAll(async () => {
    // infra-1: this suite owns its own database (cloned from the template).
    suiteDb = await useSuiteDatabase('batch_serial');
    app = await createApp(false);
    await app.init();
    facade = app.get(InventoryFacade);
  });

  afterAll(async () => {
    await cleanupRows();
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      // The ledger tables are append-only by trigger — the suite's cleanup
      // rides the superuser's replication-role bypass (sibling-suite rule).
      await sql.unsafe('set session_replication_role = replica');
      await sql.unsafe('DELETE FROM ledger_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('set session_replication_role = DEFAULT');
      await sql.unsafe('DELETE FROM ledger_anchors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM batch_on_hand WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM stock_on_hand WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM serials WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM batches WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM outbox_messages WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      // Story 2.2's scan state belongs to the tenant too (review loop 1).
      await sql.unsafe('DELETE FROM reconciliation_checkpoints WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM catalog_import_errors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM catalog_imports WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM uom_conversions WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
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

  interface AdjustBody {
    warehouseId: string;
    skuId: string;
    binId: string;
    quantityDelta: number;
    reasonCode: string;
    note: string;
    batch?: { code: string; mfgDate?: string; expiryDate?: string; overrideReason?: string };
    serials?: string[];
  }

  function adjust(body: AdjustBody, key = ulid()): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  async function createMember(
    ownerToken: string,
    role: string,
  ): Promise<{ token: string }> {
    const email = `member-${ulid().toLowerCase()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken, password: INVITEE_PASSWORD })
      .expect(200);
    return {
      token: (
        await request(app.getHttpServer())
          .post(`${API}/sign-in`)
          .send({ email, password: INVITEE_PASSWORD })
          .expect(200)
      ).body.accessToken as string,
    };
  }

  beforeAll(async () => {
    // Tenant + owner + an ops manager (holds stock.adjust).
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Trace Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;
    opsToken = (await createMember(ownerToken, 'ops_manager')).token;

    // Warehouse → zone → two bins.
    const warehouse = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: `TRC-${ulid().slice(10, 16).toUpperCase()}`, name: `Tracepoint ${ulid()}` })
      .expect(201);
    warehouseId = warehouse.body.id as string;
    const zone = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'A', name: 'Zone A' })
      .expect(201);
    const binBody = { capacity: 1000, type: 'shelf' };
    binA = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone.body.id as string}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ ...binBody, code: 'A-01-01' })
        .expect(201)
    ).body.id as string;
    binB = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone.body.id as string}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ ...binBody, code: 'A-01-02' })
        .expect(201)
    ).body.id as string;

    // Four SKUs via the import (the only SKU-creation path): batch-tracked,
    // serial-tracked, both arms, and a flagless passthrough control.
    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const csv = [
      csvHeader,
      'BT-1,Batch Pills,pcs,,1800,,true,false,,,',
      'ST-1,Serial Widgets,pcs,,1800,,false,true,,,',
      'BS-1,Both Arms,pcs,,1800,,true,true,,,',
      'PLAIN-1,Flagless,pcs,,1800,,false,false,,,',
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
    expect(skuIds.size).toBe(4);
  });

  // ── Catalog-owned identity + the batch_on_hand projection (intake) ──────

  it('batch intake: identity ensured, mfg/expiry recorded, event carries batchRef, batch_on_hand grows', async () => {
    const mfg = daysFromNow(-30);
    const expiry = daysFromNow(300);
    const res = await adjust({
      warehouseId, skuId: skuIds.get('BT-1')!, binId: binA, quantityDelta: 5,
      reasonCode: 'cycle-count', note: 'batch intake',
      batch: { code: 'B-2401', mfgDate: mfg, expiryDate: expiry },
    }).expect(201);

    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const batchRows = await sql`
        select id, code, mfg_date, expiry_date, status from batches
        where tenant_id = ${tenantId} and sku_id = ${skuIds.get('BT-1')!} and code = 'B-2401'
      `;
      expect(batchRows).toHaveLength(1);
      const batch = batchRows[0] as { id: string; mfg_date: string; expiry_date: string; status: string };
      expect(new Date(batch.mfg_date).toISOString()).toBe(new Date(mfg).toISOString());
      expect(new Date(batch.expiry_date).toISOString()).toBe(new Date(expiry).toISOString());
      expect(batch.status).toBe('active');

      const eventRows = await sql`
        select batch_ref, reference_doc, quantity_delta from ledger_events
        where tenant_id = ${tenantId} and seq = ${res.body.event.seq}
      `;
      const event = eventRows[0] as { batch_ref: string; reference_doc: Record<string, unknown>; quantity_delta: number };
      expect(event.batch_ref).toBe(batch.id);
      expect(event.quantity_delta).toBe(5);
      // Intake is not an override — the reference doc carries no reason.
      expect(event.reference_doc).toMatchObject({ kind: 'manual-adjustment', reasonCode: 'cycle-count' });
      expect('overrideReason' in event.reference_doc).toBe(false);

      const bohRows = await sql`
        select quantity from batch_on_hand
        where tenant_id = ${tenantId} and batch_id = ${batch.id} and bin_id = ${binA}
      `;
      expect(Number((bohRows[0] as { quantity: number }).quantity)).toBe(5);
    } finally {
      await sql.end();
    }
  });

  it('batch intake is idempotent identity: the same code returns the SAME batch (dates never rewritten)', async () => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      // The dates the FIRST intake (previous test) recorded — the retry's
      // different dates must not rewrite them.
      const before = await sql`
        select id, mfg_date, expiry_date from batches
        where tenant_id = ${tenantId} and sku_id = ${skuIds.get('BT-1')!} and code = 'B-2401'
      `;
      expect(before).toHaveLength(1);
      const original = before[0] as unknown as { id: string; mfg_date: Date; expiry_date: Date };

      const second = await adjust({
        warehouseId, skuId: skuIds.get('BT-1')!, binId: binA, quantityDelta: 3,
        reasonCode: 'cycle-count', note: 'same batch again',
        batch: { code: 'B-2401', mfgDate: daysFromNow(-999), expiryDate: daysFromNow(999) },
      }).expect(201);
      expect(second.body.onHand.quantity).toBe(8);

      const rows = await sql`
        select id, mfg_date, expiry_date from batches
        where tenant_id = ${tenantId} and sku_id = ${skuIds.get('BT-1')!} and code = 'B-2401'
      `;
      expect(rows).toHaveLength(1); // no duplicate identity
      const batch = rows[0] as unknown as { id: string; mfg_date: Date; expiry_date: Date };
      // The retry's different dates did NOT rewrite the original identity —
      // exact equality with the first intake's recorded dates.
      expect(batch.mfg_date.getTime()).toBe(original.mfg_date.getTime());
      expect(batch.expiry_date.getTime()).toBe(original.expiry_date.getTime());
      const boh = await sql`
        select quantity from batch_on_hand
        where tenant_id = ${tenantId} and batch_id = ${batch.id} and bin_id = ${binA}
      `;
      expect(Number((boh[0] as { quantity: number }).quantity)).toBe(8);
    } finally {
      await sql.end();
    }
  });

  it('batch-tracked intake without the batch arm is a 400; a bad batch date is a 400', async () => {
    await adjust({
      warehouseId, skuId: skuIds.get('BT-1')!, binId: binA, quantityDelta: 1,
      reasonCode: 'cycle-count', note: 'no batch',
    }).expect(400);
    await adjust({
      warehouseId, skuId: skuIds.get('BT-1')!, binId: binA, quantityDelta: 1,
      reasonCode: 'cycle-count', note: 'bad date',
      batch: { code: 'B-X', expiryDate: 'not-a-date' },
    }).expect(400);
  });

  it('untracked SKUs carrying the new arms are a 400 (per arm)', async () => {
    await adjust({
      warehouseId, skuId: skuIds.get('PLAIN-1')!, binId: binA, quantityDelta: 1,
      reasonCode: 'cycle-count', note: 'batch on flagless',
      batch: { code: 'B-NOPE' },
    }).expect(400);
    await adjust({
      warehouseId, skuId: skuIds.get('PLAIN-1')!, binId: binA, quantityDelta: 1,
      reasonCode: 'cycle-count', note: 'serials on flagless',
      serials: ['SN-X'],
    }).expect(400);
    await adjust({
      warehouseId, skuId: skuIds.get('BT-1')!, binId: binA, quantityDelta: 1,
      reasonCode: 'cycle-count', note: 'serials on batch-only',
      serials: ['SN-X'],
    }).expect(400);
  });

  it('serial-tracked movement without serials is a 400; qty ≠ serial count is a 400', async () => {
    await adjust({
      warehouseId, skuId: skuIds.get('ST-1')!, binId: binA, quantityDelta: 2,
      reasonCode: 'cycle-count', note: 'no serials',
    }).expect(400);
    await adjust({
      warehouseId, skuId: skuIds.get('ST-1')!, binId: binA, quantityDelta: 2,
      reasonCode: 'cycle-count', note: 'one serial, two units',
      serials: ['SN-A'],
    }).expect(400);
    await adjust({
      warehouseId, skuId: skuIds.get('ST-1')!, binId: binA, quantityDelta: -1,
      reasonCode: 'cycle-count', note: 'two serials, one unit out',
      serials: ['SN-A', 'SN-B'],
    }).expect(400);
  });

  // ── Serial intake / duplicate scan / draw ────────────────────────────────

  it('serial intake: exactly one ledger event per serial unit (qty +1 each, own serialRef), location derived', async () => {
    const res = await adjust({
      warehouseId, skuId: skuIds.get('ST-1')!, binId: binA, quantityDelta: 2,
      reasonCode: 'cycle-count', note: 'serial intake',
      serials: ['SN-1', 'SN-2'],
    }).expect(201);
    expect(res.body.onHand.quantity).toBe(2);

    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const events = await sql`
        select seq, quantity_delta, serial_ref, to_bin_id from ledger_events
        where tenant_id = ${tenantId} and sku_id = ${skuIds.get('ST-1')!} order by seq
      `;
      expect(events).toHaveLength(2);
      const deltas = events.map((e) => Number((e as { quantity_delta: number }).quantity_delta));
      expect(deltas).toEqual([1, 1]);
      const refs = new Set(events.map((e) => (e as { serial_ref: string }).serial_ref));
      expect(refs.size).toBe(2);

      const serials = await sql`
        select id, serial_number from serials where tenant_id = ${tenantId} and serial_number in ('SN-1','SN-2')
      `;
      expect(serials).toHaveLength(2);
      const sn1 = (serials as unknown as { id: string; serial_number: string }[]).find((s) => s.serial_number === 'SN-1')!;

      // Derived location (one query): the serial's latest event's bin.
      const location = await facade.serialLocation(tenantId, sn1.id);
      expect(location).toEqual({ warehouseId, binId: binA });
      const history = await facade.serialHistory(tenantId, sn1.id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ toBinId: binA, quantityDelta: 1 });
    } finally {
      await sql.end();
    }
  });

  it('duplicate scan: intake of a serial that lives in a bin is a 409 duplicate-serial NAMING that bin (other bin or the same one)', async () => {
    const otherBin = await adjust({
        warehouseId, skuId: skuIds.get('ST-1')!, binId: binB, quantityDelta: 1,
        reasonCode: 'cycle-count', note: 'duplicate scan elsewhere',
        serials: ['SN-1'],
      }).expect(409);
      expect(otherBin.body).toMatchObject({ status: 409, code: 'duplicate-serial' });
      expect(otherBin.body.detail).toContain(binA);

      const sameBin = await adjust({
        warehouseId, skuId: skuIds.get('ST-1')!, binId: binA, quantityDelta: 1,
        reasonCode: 'cycle-count', note: 'duplicate scan same bin',
        serials: ['SN-1'],
      }).expect(409);
      expect(sameBin.body).toMatchObject({ status: 409, code: 'duplicate-serial' });
      expect(sameBin.body.detail).toContain(binA);
  });

  it('serial draw: per-unit out events; a serial elsewhere is 409 naming its bin; unknown is 404; a drawn serial can re-enter', async () => {
    const draw = await adjust({
      warehouseId, skuId: skuIds.get('ST-1')!, binId: binA, quantityDelta: -1,
      reasonCode: 'damage', note: 'serial draw',
      serials: ['SN-1'],
    }).expect(201);
    expect(draw.body.event.quantityDelta).toBe(-1);
    expect(draw.body.onHand.quantity).toBe(1);

    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const sn1 = await sql`select id from serials where tenant_id = ${tenantId} and serial_number = 'SN-1'`;
      const sn1Id = (sn1[0] as { id: string }).id;
      const history = await facade.serialHistory(tenantId, sn1Id);
      expect(history).toHaveLength(2);
      expect(history.map((e) => e.quantityDelta)).toEqual([1, -1]);

      // The draw event itself derives the serial's last-known location.
      expect(await facade.serialLocation(tenantId, sn1Id)).toEqual({ warehouseId, binId: binA });

      // Drawing it again: out of stock — 409 naming the last-known bin.
      const redraw = await adjust({
        warehouseId, skuId: skuIds.get('ST-1')!, binId: binA, quantityDelta: -1,
        reasonCode: 'damage', note: 'double draw',
        serials: ['SN-1'],
      }).expect(409);
      expect(redraw.body).toMatchObject({ status: 409, code: 'serial-elsewhere' });

      // SN-2 lives in binA — drawing it from binB is a 409 naming binA.
      const elsewhere = await adjust({
        warehouseId, skuId: skuIds.get('ST-1')!, binId: binB, quantityDelta: -1,
        reasonCode: 'damage', note: 'wrong bin draw',
        serials: ['SN-2'],
      }).expect(409);
      expect(elsewhere.body).toMatchObject({ status: 409, code: 'serial-elsewhere' });
      expect(elsewhere.body.detail).toContain(binA);

      // A serial the ledger has never seen draws as 404.
      await adjust({
        warehouseId, skuId: skuIds.get('ST-1')!, binId: binA, quantityDelta: -1,
        reasonCode: 'damage', note: 'unknown serial',
        serials: ['SN-GHOST'],
      }).expect(404);
    } finally {
      await sql.end();
    }

    // Re-intake after a draw: the serial is out of stock and may re-enter
    // (binB starts at zero — the movement itself is its first stock there).
    const reentry = await adjust({
      warehouseId, skuId: skuIds.get('ST-1')!, binId: binB, quantityDelta: 1,
      reasonCode: 'cycle-count', note: 're-intake after draw',
      serials: ['SN-1'],
    }).expect(201);
    expect(reentry.body.onHand.quantity).toBe(1);
  });

  it('a serial-tracked adjustment is idempotent: same key + payload replays with NO second events', async () => {
    const before = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${warehouseId}/inventory/events`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    const key = ulid();
    const body: AdjustBody = {
      warehouseId, skuId: skuIds.get('ST-1')!, binId: binA, quantityDelta: 1,
      reasonCode: 'cycle-count', note: 'idempotent serials',
      serials: ['SN-IDEM'],
    };
    const first = await adjust(body, key).expect(201);
    const replay = await adjust(body, key).expect(201);
    expect(replay.body).toEqual(first.body);
    const after = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${warehouseId}/inventory/events`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    expect((after.body.items as unknown[]).length).toBe((before.body.items as unknown[]).length + 1);
  });

  it('a batch+serial-tracked SKU carries BOTH arms: one per-unit event with the batch and the serial', async () => {
    const res = await adjust({
      warehouseId, skuId: skuIds.get('BS-1')!, binId: binA, quantityDelta: 1,
      reasonCode: 'cycle-count', note: 'both arms',
      batch: { code: 'C-9001', expiryDate: daysFromNow(60) },
      serials: ['SN-C1'],
    }).expect(201);

    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const events = await sql`
        select batch_ref, serial_ref from ledger_events where tenant_id = ${tenantId} and seq = ${res.body.event.seq}
      `;
      const event = events[0] as { batch_ref: string; serial_ref: string };
      expect(event.batch_ref).not.toBeNull();
      expect(event.serial_ref).not.toBeNull();
      const boh = await sql`
        select quantity from batch_on_hand where tenant_id = ${tenantId} and batch_id = ${event.batch_ref} and bin_id = ${binA}
      `;
      expect(Number((boh[0] as { quantity: number }).quantity)).toBe(1);
      const history = await facade.batchHistory(tenantId, event.batch_ref);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ serialRef: event.serial_ref, toBinId: binA });
    } finally {
      await sql.end();
    }
  });

  // ── Batch draws: override reason, over-draw, FEFO default ────────────────

  it('explicit batch draw is an override: missing reason is a 400, a reason rides the ledger reference doc', async () => {
    const noReason = await adjust({
      warehouseId, skuId: skuIds.get('BT-1')!, binId: binA, quantityDelta: -1,
      reasonCode: 'damage', note: 'override without reason',
      batch: { code: 'B-2401' },
    }).expect(400);
    expect(noReason.body.detail).toContain('overrideReason');

    const override = await adjust({
      warehouseId, skuId: skuIds.get('BT-1')!, binId: binA, quantityDelta: -1,
      reasonCode: 'damage', note: 'override with reason',
      batch: { code: 'B-2401', overrideReason: 'oldest pallet damaged — counted out' },
    }).expect(201);

    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const events = await sql`
        select batch_ref, reference_doc from ledger_events where tenant_id = ${tenantId} and seq = ${override.body.event.seq}
      `;
      const event = events[0] as { batch_ref: string; reference_doc: Record<string, unknown> };
      expect(event.reference_doc).toMatchObject({
        kind: 'manual-adjustment',
        overrideReason: 'oldest pallet damaged — counted out',
      });
      const boh = await sql`
        select quantity from batch_on_hand where tenant_id = ${tenantId} and batch_id = ${event.batch_ref} and bin_id = ${binA}
      `;
      expect(Number((boh[0] as { quantity: number }).quantity)).toBe(7); // 8 − 1
    } finally {
      await sql.end();
    }
  });

  it('over-draw beyond the batch bin quantity is a 422 insufficient-on-hand naming the batch CODE; unknown batch is a 404', async () => {
    const overdraw = await adjust({
      warehouseId, skuId: skuIds.get('BT-1')!, binId: binA, quantityDelta: -99,
      reasonCode: 'damage', note: 'batch over-draw',
      batch: { code: 'B-2401', overrideReason: 'counted out in one go' },
    }).expect(422);
    expect(overdraw.body).toMatchObject({ status: 422, code: 'insufficient-on-hand' });
    expect(overdraw.body.detail).toContain('B-2401');

    const unknownBatch = await adjust({
      warehouseId, skuId: skuIds.get('BT-1')!, binId: binA, quantityDelta: -1,
      reasonCode: 'damage', note: 'unknown batch',
      batch: { code: 'B-GHOST', overrideReason: 'typo code' },
    }).expect(404);
    expect(unknownBatch.body).toMatchObject({ status: 404, code: 'not-found' });
  });

  it('FEFO default draw: earliest non-expired batch with stock in the bin; expired skipped; null expiry last; exhausted bin is 422', async () => {
    const sku = skuIds.get('BT-1')!;
    // Seed four batches in binB: BX (expiry +10d), BY (+2d), BZ (null), BE (expired).
    await adjust({ warehouseId, skuId: sku, binId: binB, quantityDelta: 5, reasonCode: 'cycle-count', note: 'BX', batch: { code: 'BX', expiryDate: daysFromNow(10) } }).expect(201);
    await adjust({ warehouseId, skuId: sku, binId: binB, quantityDelta: 4, reasonCode: 'cycle-count', note: 'BY', batch: { code: 'BY', expiryDate: daysFromNow(2) } }).expect(201);
    await adjust({ warehouseId, skuId: sku, binId: binB, quantityDelta: 3, reasonCode: 'cycle-count', note: 'BZ', batch: { code: 'BZ' } }).expect(201);
    await adjust({ warehouseId, skuId: sku, binId: binB, quantityDelta: 7, reasonCode: 'cycle-count', note: 'BE expired', batch: { code: 'BE', expiryDate: daysFromNow(-1) } }).expect(201);

    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    const batchIds = new Map<string, string>();
    try {
      const rows = await sql`select id, code from batches where tenant_id = ${tenantId} and sku_id = ${sku} and code in ('BX','BY','BZ','BE')`;
      for (const row of rows as unknown as { id: string; code: string }[]) {
        batchIds.set(row.code, row.id);
      }

      // Draw 1: BY (earliest non-expired expiry).
      const draw1 = await adjust({ warehouseId, skuId: sku, binId: binB, quantityDelta: -1, reasonCode: 'pick-stand-in', note: 'fefo 1' }).expect(201);
      const seq1 = await sql`select batch_ref from ledger_events where tenant_id = ${tenantId} and seq = ${draw1.body.event.seq}`;
      expect((seq1[0] as { batch_ref: string }).batch_ref).toBe(batchIds.get('BY'));

      // Draw 2-12: the rest of BY, all of BX, all of BZ — BE (expired) is
      // never default-drawn and no batch is drawn twice out of order.
      const expectedOrder = ['BY', 'BY', 'BY', 'BX', 'BX', 'BX', 'BX', 'BX', 'BZ', 'BZ', 'BZ'];
      for (const expected of expectedOrder) {
        const draw = await adjust({ warehouseId, skuId: sku, binId: binB, quantityDelta: -1, reasonCode: 'pick-stand-in', note: 'fefo n' }).expect(201);
        const seq = await sql`select batch_ref from ledger_events where tenant_id = ${tenantId} and seq = ${draw.body.event.seq}`;
        expect((seq[0] as { batch_ref: string }).batch_ref).toBe(batchIds.get(expected));
      }

      // Every non-expired batch is exhausted: the default draw refuses —
      // an explicit (override) draw of the expired BE is still possible.
      await adjust({ warehouseId, skuId: sku, binId: binB, quantityDelta: -1, reasonCode: 'pick-stand-in', note: 'nothing non-expired' }).expect(422);
      const explicit = await adjust({
        warehouseId, skuId: sku, binId: binB, quantityDelta: -1, reasonCode: 'damage', note: 'expired override',
        batch: { code: 'BE', overrideReason: 'supervisor approved the expired write-off' },
      }).expect(201);
      expect(explicit.body.onHand.quantity).toBe(6); // BE was never default-drawn: 7 − 1
    } finally {
      await sql.end();
    }
  });

  it('untracked passthrough: a flagless-SKU adjustment without the new fields behaves exactly as before', async () => {
    const res = await adjust({
      warehouseId, skuId: skuIds.get('PLAIN-1')!, binId: binA, quantityDelta: 4,
      reasonCode: 'cycle-count', note: 'plain adjustment',
    }).expect(201);
    expect(res.body.event).toMatchObject({
      type: 'stock.adjusted',
      skuId: skuIds.get('PLAIN-1'),
      binId: binA,
      quantityDelta: 4,
    });
    expect(res.body.onHand).toEqual({ skuId: skuIds.get('PLAIN-1'), binId: binA, quantity: 4 });

    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const events = await sql`
        select batch_ref, serial_ref, reference_doc from ledger_events
        where tenant_id = ${tenantId} and seq = ${res.body.event.seq}
      `;
      const event = events[0] as { batch_ref: string | null; serial_ref: string | null; reference_doc: Record<string, unknown> };
      expect(event.batch_ref).toBeNull();
      expect(event.serial_ref).toBeNull();
      expect('overrideReason' in event.reference_doc).toBe(false);
      // No phantom batch identity was created.
      const batches = await sql`select count(*)::int as n from batches where tenant_id = ${tenantId} and sku_id = ${skuIds.get('PLAIN-1')!}`;
      expect(Number(batches[0]!.n)).toBe(0);
    } finally {
      await sql.end();
    }
  });

  // ── Rebuild/reconcile parity and the one-query reads ─────────────────────

  it('rebuild parity: a tampered batch_on_hand re-derives exactly from the ledger (replay diverges, then rebuilds clean)', async () => {
    const sku = skuIds.get('BT-1')!;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`select id from batches where tenant_id = ${tenantId} and sku_id = ${sku} and code = 'B-2401'`;
      const batchId = (rows[0] as { id: string }).id;

      // The tamper: batch_on_hand is a mutable projection — no trigger guards it.
      await sql`
        update batch_on_hand set quantity = 99
        where tenant_id = ${tenantId} and batch_id = ${batchId} and bin_id = ${binA}
      `;

      const report = await facade.replay(tenantId, warehouseId);
      expect(report.matches).toBe(false);
      const batchDivergence = report.divergences.find((d) => d.batchRef === batchId);
      expect(batchDivergence).toBeDefined();
      expect(batchDivergence).toMatchObject({ skuId: sku, binId: binA, projectedQuantity: 99, replayedQuantity: 7 });

      const rebuilt = await facade.rebuildProjections(tenantId, warehouseId, { skuId: sku, binId: binA });
      const batchRepair = rebuilt.repaired.find((r) => r.batchRef === batchId);
      expect(batchRepair).toMatchObject({ quantity: 7, deleted: false });

      const after = await facade.replay(tenantId, warehouseId);
      expect(after.matches).toBe(true);
      expect(after.divergences).toEqual([]);

      const boh = await sql`select quantity from batch_on_hand where tenant_id = ${tenantId} and batch_id = ${batchId} and bin_id = ${binA}`;
      expect(Number((boh[0] as { quantity: number }).quantity)).toBe(7);
    } finally {
      await sql.end();
    }
  });

  it('one-query traceability: serial history, serial location, and batch history each return in a single read', async () => {
    const sku = skuIds.get('BS-1')!;
    // One combined intake → history for the batch and the serial.
    const res = await adjust({
      warehouseId, skuId: sku, binId: binA, quantityDelta: 2,
      reasonCode: 'cycle-count', note: 'one-query readback',
      batch: { code: 'C-9002', expiryDate: daysFromNow(90) },
      serials: ['SN-D1', 'SN-D2'],
    }).expect(201);

    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const events = await sql`
        select batch_ref, serial_ref from ledger_events where tenant_id = ${tenantId} and seq = ${res.body.event.seq}
      `;
      const batchId = (events[0] as { batch_ref: string }).batch_ref;
      const serialId = (events[0] as { serial_ref: string }).serial_ref;

      // The batch's history covers BOTH serial units of this intake (each
      // per-unit event carries the batchRef) — still one query.
      const batchHistory = await facade.batchHistory(tenantId, batchId);
      expect(batchHistory).toHaveLength(2);
      expect(batchHistory[0]).toMatchObject({ skuId: sku, toBinId: binA, quantityDelta: 1 });
      expect(batchHistory[1]).toMatchObject({ skuId: sku, toBinId: binA, quantityDelta: 1 });

      const serialHistory = await facade.serialHistory(tenantId, serialId);
      expect(serialHistory).toHaveLength(1);
      expect(serialHistory[0]).toMatchObject({ skuId: sku, toBinId: binA, batchRef: batchId });

      const location = await facade.serialLocation(tenantId, serialId);
      expect(location).toEqual({ warehouseId, binId: binA });
      // An unknown serial reads as never-moved, not an error.
      expect(await facade.serialLocation(tenantId, uuidv7())).toBeNull();
    } finally {
      await sql.end();
    }
  });

  // ── 0010 deployment probes: RLS + CHECKs ─────────────────────────────────

  it('RLS on the 0010 tables: an un-scoped session sees zero rows; a scoped session sees its own', async () => {
    const probe = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const rls = postgres(url.toString(), { max: 1 });
      try {
        for (const table of ['batches', 'serials', 'batch_on_hand']) {
          const unscoped = await rls.unsafe(`select count(*)::int as n from ${table}`);
          expect(Number(unscoped[0]!.n)).toBe(0);
        }
        await rls.unsafe(`select set_config('app.tenant_id', '${tenantId}', false)`);
        const scoped = await rls.unsafe('select count(*)::int as n from batches');
        expect(Number(scoped[0]!.n)).toBeGreaterThan(0);
      } finally {
        await rls.end();
      }
    } finally {
      await probe.end();
    }
  });

  it('CHECKs on the 0010 tables: negative batch on-hand and a typo status are DB-rejected', async () => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const batch = await sql`select id, sku_id from batches where tenant_id = ${tenantId} and code = 'B-2401' limit 1`;
      const { id: batchId, sku_id: skuId } = batch[0] as { id: string; sku_id: string };

      await expect(sql`
        insert into batch_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, batch_id, quantity)
        values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${skuId}, ${binB}, ${batchId}, -1)
      `).rejects.toThrow(/batch_on_hand_quantity_nonnegative/);

      await expect(sql`
        update batches set status = 'shipped' where id = ${batchId}
      `).rejects.toThrow(/batches_status_check/);

      const serial = await sql`select id from serials where tenant_id = ${tenantId} limit 1`;
      const serialId = (serial[0] as { id: string }).id;
      await expect(sql`
        update serials set status = 'lost' where id = ${serialId}
      `).rejects.toThrow(/serials_status_check/);
    } finally {
      await sql.end();
    }
  });

  // ── Review loop 1 pins: replay beats composition, normalization, 403 ────

  it('same-key retry with a DIFFERENT batch.code or serials array is a 422 idempotency-key-reuse — and creates no identity', async () => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const beforeBatches = await sql`select count(*)::int as n from batches where tenant_id = ${tenantId}`;
      const beforeSerials = await sql`select count(*)::int as n from serials where tenant_id = ${tenantId}`;

      const batchKey = ulid();
      await adjust({
        warehouseId, skuId: skuIds.get('BT-1')!, binId: binA, quantityDelta: 1,
        reasonCode: 'cycle-count', note: 'idem arms A',
        batch: { code: 'B-IDEM-A' },
      }, batchKey).expect(201);
      const differentCode = await adjust({
        warehouseId, skuId: skuIds.get('BT-1')!, binId: binA, quantityDelta: 1,
        reasonCode: 'cycle-count', note: 'idem arms A — different code',
        batch: { code: 'B-IDEM-B' },
      }, batchKey).expect(422);
      expect(differentCode.body).toMatchObject({ status: 422, code: 'idempotency-key-reuse' });

      const serialKey = ulid();
      await adjust({
        warehouseId, skuId: skuIds.get('ST-1')!, binId: binA, quantityDelta: 1,
        reasonCode: 'cycle-count', note: 'idem arms S',
        serials: ['SN-IDEM-R1'],
      }, serialKey).expect(201);
      const differentSerials = await adjust({
        warehouseId, skuId: skuIds.get('ST-1')!, binId: binA, quantityDelta: 1,
        reasonCode: 'cycle-count', note: 'idem arms S — different serials',
        serials: ['SN-IDEM-R2'],
      }, serialKey).expect(422);
      expect(differentSerials.body).toMatchObject({ status: 422, code: 'idempotency-key-reuse' });

      // The rejected retries created NO catalog identity (the replay decision
      // precedes the composition — the ensure calls never ran).
      const afterBatches = await sql`select count(*)::int as n from batches where tenant_id = ${tenantId}`;
      const afterSerials = await sql`select count(*)::int as n from serials where tenant_id = ${tenantId}`;
      expect(Number((afterBatches[0] as { n: number }).n)).toBe(Number((beforeBatches[0] as { n: number }).n) + 1);
      expect(Number((afterSerials[0] as { n: number }).n)).toBe(Number((beforeSerials[0] as { n: number }).n) + 1);
      const phantom = await sql`
        select count(*)::int as n from batches where tenant_id = ${tenantId} and code = 'B-IDEM-B'
      `;
      expect(Number((phantom[0] as { n: number }).n)).toBe(0);
    } finally {
      await sql.end();
    }
  });

  it('a batch-tracked same-key replay returns the stored snapshot with no second event — even after the FEFO batch is exhausted', async () => {
    const sku = skuIds.get('BT-1')!;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      // Seed one non-expired batch into binB (BE is there but expired — the
      // default draw must resolve the fresh batch).
      await adjust({
        warehouseId, skuId: sku, binId: binB, quantityDelta: 5,
        reasonCode: 'cycle-count', note: 'BR seed',
        batch: { code: 'BR', expiryDate: daysFromNow(30) },
      }).expect(201);

      // The FEFO default draw whose retry this test replays.
      const key = ulid();
      const body: AdjustBody = {
        warehouseId, skuId: sku, binId: binB, quantityDelta: -1,
        reasonCode: 'pick-stand-in', note: 'fefo replay',
      };
      const first = await adjust(body, key).expect(201);
      expect(first.body.event.quantityDelta).toBe(-1);

      // Exhaust the resolved batch: binB's only non-expired stock is gone.
      for (let i = 0; i < 4; i += 1) {
        await adjust(body).expect(201);
      }
      // A NEW default draw now fails — the FEFO resolution has nothing left
      // (the exact state that broke the pre-review-loop implementation).
      await adjust(body).expect(422);

      // The retry of the ORIGINAL key still replays the stored snapshot —
      // the replay decision never consults the bin's current batch state.
      const eventsBefore = await sql`
        select count(*)::int as n from ledger_events where tenant_id = ${tenantId} and warehouse_id = ${warehouseId}
      `;
      const replay = await adjust(body, key).expect(201);
      expect(replay.body).toEqual(first.body);
      const eventsAfter = await sql`
        select count(*)::int as n from ledger_events where tenant_id = ${tenantId} and warehouse_id = ${warehouseId}
      `;
      expect(Number((eventsAfter[0] as { n: number }).n)).toBe(Number((eventsBefore[0] as { n: number }).n));
    } finally {
      await sql.end();
    }
  });

  it('reconcile SCAN (bounded window): a tampered batch_on_hand row inside the window diverges with batchRef, and the cycle repairs it', async () => {
    const sku = skuIds.get('BT-1')!;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      // Cycle 1: clean full pass — advances the checkpoint to the watermark.
      const first = await facade.reconcile(tenantId, warehouseId);
      expect(first.divergences).toEqual([]);
      expect(first.advanced).toBe(true);

      // New movement INSIDE the next window, then tamper its projection row.
      const seeded = await adjust({
        warehouseId, skuId: sku, binId: binA, quantityDelta: 3,
        reasonCode: 'cycle-count', note: 'scan seed',
        batch: { code: 'B-SCAN', expiryDate: daysFromNow(45) },
      }).expect(201);
      const batchRows = await sql`
        select id from batches where tenant_id = ${tenantId} and sku_id = ${sku} and code = 'B-SCAN'
      `;
      const batchId = (batchRows[0] as { id: string }).id;
      await sql`
        update batch_on_hand set quantity = 99
        where tenant_id = ${tenantId} and batch_id = ${batchId} and bin_id = ${binA}
      `;

      // Cycle 2: the bounded scan compares exactly the window's scopes — the
      // tampered batch arm diverges, NAMED by its batchRef, and is repaired.
      const second = await facade.reconcile(tenantId, warehouseId);
      expect(second.divergences).toHaveLength(1);
      expect(second.divergences[0]).toMatchObject({
        skuId: sku,
        binId: binA,
        batchRef: batchId,
        projectedQuantity: 99,
        replayedQuantity: 3,
      });
      expect(second.divergences[0]?.fromSeq).toBeGreaterThan(first.watermark);
      const repair = second.repaired.find((r) => r.batchRef === batchId);
      expect(repair).toMatchObject({ quantity: 3, deleted: false });
      expect(seeded.body.event.seq).toBeGreaterThan(first.watermark);

      // Cycle 3: clean again.
      const third = await facade.reconcile(tenantId, warehouseId);
      expect(third.divergences).toEqual([]);
    } finally {
      await sql.end();
    }
  });

  it('permission before validation AND identity: a denied-role member\'s batch-armed adjustment is 403 and leaves zero catalog rows', async () => {
    const member = await createMember(ownerToken, 'operator'); // holds no stock.adjust
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const beforeBatches = await sql`select count(*)::int as n from batches where tenant_id = ${tenantId}`;
      const beforeSerials = await sql`select count(*)::int as n from serials where tenant_id = ${tenantId}`;

      const denied = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${member.token}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          skuId: skuIds.get('BT-1')!,
          binId: binA,
          quantityDelta: 1,
          reasonCode: 'cycle-count',
          note: 'denied armed adjust',
          batch: { code: 'B-DENIED' },
        })
        .expect(403);
      expect(denied.body).toMatchObject({ status: 403, code: 'role-denied' });

      // Not one identity row: the assert precedes ANY ensure call.
      const afterBatches = await sql`select count(*)::int as n from batches where tenant_id = ${tenantId}`;
      const afterSerials = await sql`select count(*)::int as n from serials where tenant_id = ${tenantId}`;
      expect(Number((afterBatches[0] as { n: number }).n)).toBe(Number((beforeBatches[0] as { n: number }).n));
      expect(Number((afterSerials[0] as { n: number }).n)).toBe(Number((beforeSerials[0] as { n: number }).n));
    } finally {
      await sql.end();
    }
  });

  it('RLS cross-tenant: tenant A\'s scoped session sees ZERO of tenant B\'s rows on all three 0010 tables', async () => {
    const foreignTenant = uuidv7();
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      // Seed one row per 0010 table for a foreign tenant (no FKs — the repo
      // convention). The app's own tenant keeps its real rows.
      await sql`
        insert into batches (id, tenant_id, sku_id, code, status)
        values (${uuidv7()}, ${foreignTenant}, ${uuidv7()}, 'FOREIGN-B', 'active')
      `;
      await sql`
        insert into serials (id, tenant_id, sku_id, serial_number, status)
        values (${uuidv7()}, ${foreignTenant}, ${uuidv7()}, 'FOREIGN-SN', 'active')
      `;
      await sql`
        insert into batch_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, batch_id, quantity)
        values (${uuidv7()}, ${foreignTenant}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, 5)
      `;

      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const rls = postgres(url.toString(), { max: 1 });
      try {
        await rls.unsafe(`select set_config('app.tenant_id', '${tenantId}', false)`);
        for (const table of ['batches', 'serials', 'batch_on_hand']) {
          const foreign = await rls.unsafe(
            `select count(*)::int as n from ${table} where tenant_id = '${foreignTenant}'::uuid`,
          );
          expect(Number((foreign[0] as unknown as { n: number }).n)).toBe(0);
        }
        // Control: scoped to the foreign tenant the same rows ARE visible —
        // the probe saw them; the isolation, not an empty store, is proven.
        await rls.unsafe(`select set_config('app.tenant_id', '${foreignTenant}', false)`);
        for (const table of ['batches', 'serials', 'batch_on_hand']) {
          const own = await rls.unsafe(`select count(*)::int as n from ${table}`);
          expect(Number((own[0] as unknown as { n: number }).n)).toBe(1);
        }
      } finally {
        await rls.end();
      }
    } finally {
      await sql.unsafe('set session_replication_role = replica');
      await sql.unsafe(`delete from batches where tenant_id = '${foreignTenant}'::uuid`);
      await sql.unsafe(`delete from serials where tenant_id = '${foreignTenant}'::uuid`);
      await sql.unsafe(`delete from batch_on_hand where tenant_id = '${foreignTenant}'::uuid`);
      await sql.unsafe('set session_replication_role = DEFAULT');
      await sql.end();
    }
  });

  it('an unknown skuId carrying an arm is a 404 not-found (before any identity work)', async () => {
    await adjust({
      warehouseId, skuId: uuidv7(), binId: binA, quantityDelta: 1,
      reasonCode: 'cycle-count', note: 'arm on unknown sku',
      batch: { code: 'B-GHOST-SKU' },
    }).expect(404);
  });

  it('intake carrying batch.overrideReason is a 400 (the reason is the override-draw audit field only)', async () => {
    await adjust({
      warehouseId, skuId: skuIds.get('BT-1')!, binId: binA, quantityDelta: 1,
      reasonCode: 'cycle-count', note: 'intake with a reason',
      batch: { code: 'B-REASON-INTAKE', overrideReason: 'not a draw' },
    }).expect(400);
  });

  it('an inverted-dated batch (expiry before mfg) is a 400 at intake — FEFO never sees it', async () => {
    await adjust({
      warehouseId, skuId: skuIds.get('BT-1')!, binId: binA, quantityDelta: 1,
      reasonCode: 'cycle-count', note: 'inverted dates',
      batch: { code: 'B-INVERTED', mfgDate: daysFromNow(30), expiryDate: daysFromNow(-30) },
    }).expect(400);
  });

  it('a FEFO default draw larger than the resolved batch holds reaches the ledger fold guard: 422 insufficient-on-hand', async () => {
    const sku = skuIds.get('BT-1')!;
    // Small earliest-expiry batch (FEFO resolves it) + a larger later one.
    await adjust({ warehouseId, skuId: sku, binId: binB, quantityDelta: 2, reasonCode: 'cycle-count', note: 'small', batch: { code: 'B-SMALL', expiryDate: daysFromNow(5) } }).expect(201);
    await adjust({ warehouseId, skuId: sku, binId: binB, quantityDelta: 10, reasonCode: 'cycle-count', note: 'large', batch: { code: 'B-LARGE', expiryDate: daysFromNow(50) } }).expect(201);

    // Draw more than the earliest batch holds in one movement: no spanning —
    // the ledger's batch fold guard rejects naming the resolved batchRef.
    const overdraw = await adjust({
      warehouseId, skuId: sku, binId: binB, quantityDelta: -5,
      reasonCode: 'pick-stand-in', note: 'beyond the earliest batch',
    }).expect(422);
    expect(overdraw.body).toMatchObject({ status: 422, code: 'insufficient-on-hand' });
  });

  it('a draw carrying BOTH serials and an explicit batch.overrideReason succeeds; the reason rides the reference doc', async () => {
    const sku = skuIds.get('BS-1')!;
    await adjust({
      warehouseId, skuId: sku, binId: binA, quantityDelta: 1,
      reasonCode: 'cycle-count', note: 'both-arms intake for the draw',
      batch: { code: 'C-9004', expiryDate: daysFromNow(20) },
      serials: ['SN-O1'],
    }).expect(201);

    const draw = await adjust({
      warehouseId, skuId: sku, binId: binA, quantityDelta: -1,
      reasonCode: 'damage', note: 'both arms out, explicit batch',
      batch: { code: 'C-9004', overrideReason: 'damaged unit counted out of its batch' },
      serials: ['SN-O1'],
    }).expect(201);

    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const events = await sql`
        select batch_ref, serial_ref, reference_doc from ledger_events
        where tenant_id = ${tenantId} and seq = ${draw.body.event.seq}
      `;
      const event = events[0] as { batch_ref: string; serial_ref: string; reference_doc: Record<string, unknown> };
      expect(event.batch_ref).not.toBeNull();
      expect(event.serial_ref).not.toBeNull();
      expect(event.reference_doc).toMatchObject({
        kind: 'manual-adjustment',
        overrideReason: 'damaged unit counted out of its batch',
      });
    } finally {
      await sql.end();
    }
  });

  it('two concurrent adjustments of the SAME serial: exactly one wins, the loser fails, one ledger event exists', async () => {
    const body: AdjustBody = {
      warehouseId, skuId: skuIds.get('ST-1')!, binId: binB, quantityDelta: 1,
      reasonCode: 'cycle-count', note: 'concurrent scan',
      serials: ['SN-RACE'],
    };
    const settled = await Promise.allSettled([adjust(body), adjust(body)]);
    const statuses = settled.map((outcome) =>
      outcome.status === 'fulfilled' ? outcome.value.status : (outcome.reason as { status: number }).status,
    );
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409 || status === 422)).toHaveLength(1);

    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const serialRows = await sql`
        select id from serials where tenant_id = ${tenantId} and serial_number = 'SN-RACE'
      `;
      const serialId = (serialRows[0] as unknown as { id: string }).id;
      const events = await sql`
        select count(*)::int as n from ledger_events where tenant_id = ${tenantId} and serial_ref = ${serialId}
      `;
      expect(Number((events[0] as unknown as { n: number }).n)).toBe(1);
    } finally {
      await sql.end();
    }
  });
});