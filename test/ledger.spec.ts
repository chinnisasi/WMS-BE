import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { ProblemException } from '../src/shared/problem-details/problem.exception';

// The e2e suite talks to the real Postgres (docker-compose dev DB by
// default; CI provides the service container) and signs sessions.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';

const API = '/api/v1/tenants';
/** The invitee's own password (set at accept-invite, spec 1.5). */
const INVITEE_PASSWORD = 'team-member-password';
/** The one Idempotency-Key header (spec 2.1 / AD-5). */
const KEY_HEADER = 'Idempotency-Key';
/** Genesis chain predecessor (AD-16) — asserted on the first event row. */
const GENESIS = '0'.repeat(64);

interface AdjustBody {
  warehouseId: string;
  skuId: string;
  binId: string;
  quantityDelta: number;
  reasonCode: string;
  note: string;
  /** Business time; omitted by default (the commit clock then applies). */
  occurredAt?: string;
}

describe('append-only ledger core and derived quantities (e2e, story 2.1)', () => {
  let app: INestApplication;
  let facade: InventoryFacade;
  const createdTenantIds: string[] = [];

  // Seeded aggregate roots shared by the suite (one tenant, one warehouse,
  // two bins, one SKU — the smallest scope the I/O matrix exercises).
  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let opsUserId: string;
  let operatorToken: string;
  let warehouseId: string;
  let binA: string;
  let binB: string;
  let skuId: string;

  beforeAll(async () => {
    // Same deployment-parity probes as users.spec.ts (auth + RLS roles,
    // serialized across parallel jest workers by the advisory lock).
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(742105)`;
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
    facade = app.get(InventoryFacade);
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
      // The ledger tables are append-only by trigger — the trigger is not
      // RLS and fires even for the table owner, so the suite's own cleanup
      // must take the superuser's replication-role bypass. Nothing else.
      await sql.unsafe('set session_replication_role = replica');
      await sql.unsafe('DELETE FROM ledger_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM ledger_anchors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('set session_replication_role = DEFAULT');
      await sql.unsafe('DELETE FROM stock_on_hand WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      // The suite's committed outbox rows must not linger (the relay
      // worker is env-gated OFF in tests — nothing drains them here).
      await sql.unsafe('DELETE FROM outbox_messages WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
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

  function adjust(token: string, body: AdjustBody, key = ulid()): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function adjustmentBody(overrides: Partial<AdjustBody> = {}): AdjustBody {
    return {
      warehouseId,
      skuId,
      binId: binA,
      quantityDelta: 5,
      reasonCode: 'cycle-count',
      note: 'count correction',
      ...overrides,
    };
  }

  function listEvents(token: string, query: Record<string, unknown> = {}): SupertestTest {
    return request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${warehouseId}/inventory/events`)
      .query(query)
      .set('Authorization', `Bearer ${token}`);
  }

  async function eventCount(): Promise<number> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`
        select count(*)::int as n from ledger_events where tenant_id = ${tenantId}
      `;
      return Number(rows[0]!.n);
    } finally {
      await sql.end();
    }
  }

  async function onHandFor(targetBinId: string): Promise<number> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`
        select quantity from stock_on_hand
        where tenant_id = ${tenantId} and bin_id = ${targetBinId}
      `;
      return Number(rows[0]!.quantity);
    } finally {
      await sql.end();
    }
  }

  async function createMember(
    ownerToken: string,
    role: string,
  ): Promise<{ userId: string; token: string }> {
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
    const signedIn = await request(app.getHttpServer())
      .post(`${API}/sign-in`)
      .send({ email, password: INVITEE_PASSWORD })
      .expect(200);
    return {
      userId: signedIn.body.user.id as string,
      token: signedIn.body.accessToken as string,
    };
  }

  beforeAll(async () => {
    // Tenant + owner.
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Ledger Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;

    // An ops_manager (holds stock.adjust) and an operator (holds none).
    const ops = await createMember(ownerToken, 'ops_manager');
    opsToken = ops.token;
    opsUserId = ops.userId;
    operatorToken = (await createMember(ownerToken, 'operator')).token;

    // Warehouse → zone → two bins.
    const warehouse = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: `BLR-${ulid().slice(10, 16).toUpperCase()}`, name: `Whitefield ${ulid()}` })
      .expect(201);
    warehouseId = warehouse.body.id as string;
    const zone = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'A', name: 'Zone A' })
      .expect(201);
    const zoneId = zone.body.id as string;
    const binBody = { capacity: 100, type: 'shelf' };
    const firstBin = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ ...binBody, code: 'A-01-01' })
      .expect(201);
    binA = firstBin.body.id as string;
    const secondBin = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ ...binBody, code: 'A-01-02' })
      .expect(201);
    binB = secondBin.body.id as string;

    // One SKU via catalog import (the only SKU-creation path).
    const csvHeader = 'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const csv = `${csvHeader}\nSKU-1,Turmeric,pcs,,1800,,,,,`;
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
    const sku = (skus.body.items as { code: string; id: string }[]).find(
      (item) => item.code === 'SKU-1',
    )!;
    skuId = sku.id;
  });

  it('happy path: one commit writes exactly one event + the projection, and the response carries event id/seq/on-hand', async () => {
    const res = await adjust(opsToken, adjustmentBody()).expect(201);
    expect(res.body.event).toMatchObject({
      seq: 1,
      type: 'stock.adjusted',
      skuId,
      binId: binA,
      quantityDelta: 5,
    });
    expect(typeof res.body.event.id).toBe('string');
    expect(res.body.onHand).toEqual({ skuId, binId: binA, quantity: 5 });

    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const events = await sql`
        select seq, type, quantity_delta, prev_hash, event_hash, from_bin_id, to_bin_id
        from ledger_events where tenant_id = ${tenantId}
      `;
      expect(events).toHaveLength(1);
      const event = events[0] as {
        seq: number;
        type: string;
        quantity_delta: number;
        prev_hash: string;
        event_hash: string;
        from_bin_id: string | null;
        to_bin_id: string | null;
      };
      expect(event.seq).toBe(1);
      expect(event.type).toBe('stock.adjusted');
      expect(event.quantity_delta).toBe(5);
      expect(event.to_bin_id).toBe(binA);
      expect(event.from_bin_id).toBeNull();
      // Genesis linkage + a real hash over the canonical bytes.
      expect(event.prev_hash).toBe(GENESIS);
      expect(event.event_hash).toMatch(/^[0-9a-f]{64}$/);

      expect(await onHandFor(binA)).toBe(5);
    } finally {
      await sql.end();
    }
  });

  it('idempotent replay: same key + same payload replays the original response with no second event', async () => {
    const key = ulid();
    const first = await adjust(opsToken, adjustmentBody({ quantityDelta: 3 }), key).expect(201);
    expect(first.body.event.seq).toBe(2);
    const replay = await adjust(opsToken, adjustmentBody({ quantityDelta: 3 }), key).expect(201);
    expect(replay.body).toEqual(first.body);
    expect(await eventCount()).toBe(2);
  });

  it('idempotency-key reuse with a mutated payload is a 422 idempotency-key-reuse', async () => {
    const key = ulid();
    await adjust(opsToken, adjustmentBody({ binId: binB, quantityDelta: 2 }), key).expect(201);
    const reuse = await adjust(opsToken, adjustmentBody({ binId: binB, quantityDelta: 4 }), key).expect(422);
    expect(reuse.body).toMatchObject({ status: 422, code: 'idempotency-key-reuse' });
    expect(await eventCount()).toBe(3);
  });

  it('concurrent adjustments on the same warehouse commit with distinct gap-free seqs and a summed projection', async () => {
    const before = await eventCount();
    const [first, second] = await Promise.all([
      adjust(opsToken, adjustmentBody({ binId: binB, quantityDelta: 3 })),
      adjust(opsToken, adjustmentBody({ binId: binB, quantityDelta: 4 })),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // Distinct seqs, consecutive in one of the two commit orders — the
    // advisory-per-warehouse lock serializes the two appends.
    const seqs = [first.body.event.seq, second.body.event.seq] as number[];
    expect(new Set(seqs).size).toBe(2);

    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const all = await sql`
        select seq from ledger_events where tenant_id = ${tenantId} order by seq
      `;
      const ordered = (all as unknown as { seq: number }[]).map((row) => row.seq);
      // Gap-free per warehouse: exactly 1..N, including the two new events.
      expect(ordered).toEqual(ordered.map((_, index) => index + 1));
      expect(ordered.length).toBe(before + 2);
      expect(new Set([...seqs, ...ordered]).size).toBe(before + 2);
      // No lost update: the projection sums every committed delta
      // (binB carried +2 from the previous test, then +3 and +4).
      expect(await onHandFor(binB)).toBe(9);
    } finally {
      await sql.end();
    }
  });

  it('capability missing: an operator adjustment is 403 role-denied naming role + capability', async () => {
    const denied = await adjust(operatorToken, adjustmentBody({ quantityDelta: 1 })).expect(403);
    expect(denied.body).toMatchObject({ status: 403, code: 'role-denied' });
    expect(denied.body.detail).toContain('operator');
    expect(denied.body.detail).toContain('stock.adjust');
    expect(await eventCount()).toBe(5);
  });

  it('actor demoted after the original request: the replay is 403 before the snapshot is served', async () => {
    const key = ulid();
    const body = adjustmentBody({ binId: binB, quantityDelta: 1 });
    await adjust(opsToken, body, key).expect(201);

    await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/users/${opsUserId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ role: 'operator' })
      .expect(200);

    const replay = await adjust(opsToken, body, key).expect(403);
    expect(replay.body).toMatchObject({ status: 403, code: 'role-denied' });
    expect(replay.body.detail).toContain('stock.adjust');

    // Restore for the later tests in this suite.
    await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/users/${opsUserId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ role: 'ops_manager' })
      .expect(200);
  });

  it('over-draw: 422 insufficient-on-hand naming the bin and current on-hand, with nothing persisted', async () => {
    const before = await eventCount();
    const overdraw = await adjust(opsToken, adjustmentBody({ quantityDelta: -999999 })).expect(422);
    expect(overdraw.body).toMatchObject({ status: 422, code: 'insufficient-on-hand' });
    expect(overdraw.body.detail).toContain(binA);
    expect(overdraw.body.detail).toContain('currently holds');
    expect(await eventCount()).toBe(before);
  });

  it('replay equivalence: recomputing on-hand from events matches the stored projection exactly', async () => {
    const report = await facade.replay(tenantId, warehouseId);
    expect(report.matches).toBe(true);
    expect(report.divergences).toEqual([]);
    expect(report.eventCount).toBe(await eventCount());
    expect(report.warehouseId).toBe(warehouseId);
  });

  it('chain verify on an untampered chain: ok, over the full committed range', async () => {
    const report = await facade.verifyChain(tenantId, warehouseId);
    expect(report.ok).toBe(true);
    if (report.ok === true) {
      expect(report.fromSeq).toBe(1);
      expect(report.eventCount).toBe(await eventCount());
    }
  });

  it('append-only enforcement: the database raises on UPDATE and DELETE and leaves the row unchanged', async () => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`
        select seq, quantity_delta, event_hash from ledger_events
        where tenant_id = ${tenantId} order by seq limit 1
      `;
      const row = rows[0] as {
        seq: number;
        quantity_delta: number;
        event_hash: string;
      };
      const update = sql`
        update ledger_events set quantity_delta = ${row.quantity_delta + 1}
        where tenant_id = ${tenantId} and seq = ${row.seq}
      `;
      await expect(update).rejects.toThrow(/append-only/i);
      const remove = sql`
        delete from ledger_events where tenant_id = ${tenantId} and seq = ${row.seq}
      `;
      await expect(remove).rejects.toThrow(/append-only/i);
      const after = await sql`
        select quantity_delta, event_hash from ledger_events
        where tenant_id = ${tenantId} and seq = ${row.seq}
      `;
      const intact = after[0] as { quantity_delta: number; event_hash: string };
      expect(intact.quantity_delta).toBe(row.quantity_delta);
      expect(intact.event_hash).toBe(row.event_hash);
    } finally {
      await sql.end();
    }
  });

  it('chain tamper probe: a direct SQL quantity edit is detected with scope + seq range and a severity-1 alert', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      // The deliberate tamper: the append-only trigger is a plain (not
      // ALWAYS) trigger, so the superuser's replication role bypasses it —
      // exactly the threat the verifier exists to catch.
      await sql.unsafe('set session_replication_role = replica');
      await sql.unsafe(
        'update ledger_events set quantity_delta = quantity_delta + 1 where tenant_id = $1 and seq = 1',
        [tenantId],
      );
      await sql.unsafe('set session_replication_role = DEFAULT');
    } finally {
      await sql.end();
    }
    const report = await facade.verifyChain(tenantId, warehouseId);
    expect(report.ok).toBe(false);
    if (report.ok === false) {
      expect(report.tenantId).toBe(tenantId);
      expect(report.warehouseId).toBe(warehouseId);
      expect(report.fromSeq).toBe(1);
      expect(report.reason).toContain('hash mismatch at seq 1');
    }
    // Severity-1 alert: the error log names the scope and the seq range.
    expect(errorSpy).toHaveBeenCalled();
    const alertText = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(alertText).toContain('ledger chain break');
    expect(alertText).toContain(`tenant=${tenantId}`);
    expect(alertText).toContain(`warehouse=${warehouseId}`);
    expect(alertText).toContain('seq=1..');
    errorSpy.mockRestore();
  });

  it('anchors and digest exports: deterministic, verifiable, append-only, and single-anchored', async () => {
    const last = await eventCount();
    const anchor = await facade.anchorChain(tenantId, warehouseId);
    expect(anchor.fromSeq).toBe(1);
    expect(anchor.toSeq).toBe(last);
    expect(anchor.digest).toMatch(/^[0-9a-f]{64}$/);

    // Re-anchoring with nothing new is a loud 422 ProblemException, not a
    // duplicate anchor row.
    const again = facade.anchorChain(tenantId, warehouseId);
    let caught: unknown;
    try {
      await again;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProblemException);
    expect((caught as ProblemException).getStatus()).toBe(422);

    const digest = await facade.exportDigest(tenantId, warehouseId, 1, last);
    expect(digest.eventCount).toBe(last);
    // Determinism: the same range always yields the same artifact digest.
    const digestAgain = await facade.exportDigest(tenantId, warehouseId, 1, last);
    expect(digestAgain.digest).toBe(digest.digest);
    // The anchor covers the same range with the same digest.
    expect(digest.digest).toBe(anchor.digest);

    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const anchors = await sql`
        select from_seq, to_seq, digest from ledger_anchors where tenant_id = ${tenantId}
      `;
      expect(anchors).toHaveLength(1);
      const stored = anchors[0] as { from_seq: number; to_seq: number; digest: string };
      expect(stored.from_seq).toBe(1);
      expect(stored.to_seq).toBe(last);
      expect(stored.digest).toBe(anchor.digest);
    } finally {
      await sql.end();
    }
  });

  it('event timeline: newest-first keyset cursor pagination with a working SKU filter', async () => {
    const total = await eventCount();
    expect(total).toBeGreaterThanOrEqual(6);

    const firstPage = await listEvents(opsToken, { limit: 2 }).expect(200);
    const items = firstPage.body.items as { seq: number; id: string }[];
    expect(items).toHaveLength(2);
    expect(items[0]!.seq).toBeGreaterThan(items[1]!.seq);
    const cursor = firstPage.body.nextCursor as string | null;
    expect(cursor).toBeTruthy();

    // Walking the cursor visits every event exactly once, ending null.
    const seen: number[] = items.map((item) => item.seq);
    let nextCursor: string | null = cursor;
    let guard = 0;
    while (nextCursor !== null && guard < 50) {
      const page = await listEvents(opsToken, { limit: 2, cursor: nextCursor }).expect(200);
      seen.push(...(page.body.items as { seq: number }[]).map((item) => item.seq));
      nextCursor = page.body.nextCursor as string | null;
      guard += 1;
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);

    // The SKU filter narrows to that SKU's events only.
    const filtered = await listEvents(opsToken, { skuId }).expect(200);
    const filteredItems = filtered.body.items as { skuId: string }[];
    expect(filteredItems.length).toBeGreaterThan(0);
    for (const item of filteredItems) {
      expect(item.skuId).toBe(skuId);
    }

    // A crafted-but-invalid cursor is a 400 invalid-cursor, never a 500.
    const bogus = Buffer.from(JSON.stringify({ id: 'not-a-uuid', createdAt: 'nope' })).toString('base64');
    const rejected = await listEvents(opsToken, { cursor: bogus }).expect(400);
    expect(rejected.body).toMatchObject({ status: 400, code: 'invalid-cursor' });
  });

  it('row-level security: the three new tables are tenant-isolated and fail closed', async () => {
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    let scoped: ReturnType<typeof postgres> | undefined;
    try {
      await admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(742105)`;
        await tx.unsafe(`
          do $$ begin
            if not exists (select from pg_roles where rolname = 'wms_rls_probe') then
              create role wms_rls_probe login password 'wms_rls_probe' nosuperuser;
            end if;
          end $$;
        `);
        await tx.unsafe('grant usage on schema public to wms_rls_probe');
        await tx.unsafe(
          'grant select, insert, update, delete on all tables in schema public to wms_rls_probe',
        );
      });
      const probeUrl = new URL(process.env.DATABASE_URL!);
      probeUrl.username = 'wms_rls_probe';
      probeUrl.password = 'wms_rls_probe';
      const probe = postgres(probeUrl.toString(), { max: 1 });
      scoped = probe;

      const otherTenant = uuidv7();
      for (const table of ['ledger_events', 'stock_on_hand', 'ledger_anchors']) {
        // Every scoped read runs inside a transaction carrying
        // app.tenant_id — the same probe shape as tenancy.spec.ts.
        const own = await probe.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
          return tx`select id from ${probe(table)} where tenant_id = ${tenantId}`;
        });
        expect(own.length).toBeGreaterThan(0);

        const foreign = await probe.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${otherTenant}, true)`;
          return tx`select id from ${probe(table)} where tenant_id = ${tenantId}`;
        });
        expect(foreign).toHaveLength(0);

        // No app.tenant_id at all → fail closed.
        const unscoped = await probe`select id from ${probe(table)}`;
        expect(unscoped).toHaveLength(0);
      }


      // The write side fails closed too: a scoped connection cannot seed a
      // row stamped with a tenant its session is not scoped to (42501).
      const foreignEvent = scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        await tx`
          insert into ledger_events (id, tenant_id, warehouse_id, seq, type, schema_version, sku_id, quantity_delta, actor_user_id, occurred_at, recorded_at, prev_hash, event_hash, reference_doc)
          values (${uuidv7()}, ${otherTenant}, ${uuidv7()}, 1, 'stock.adjusted', 1, ${uuidv7()}, 1, ${uuidv7()}, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ${GENESIS}, ${GENESIS}, '{"kind":"manual-adjustment"}')
        `;
      });
      await expect(foreignEvent).rejects.toThrow(/row-level security/i);

      const projectionInsert = scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        await tx`
          insert into stock_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, quantity)
          values (${uuidv7()}, ${otherTenant}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, 1)
        `;
      });
      await expect(projectionInsert).rejects.toThrow(/row-level security/i);

      // ledger_anchors is covered too: a scoped non-bypass session cannot
      // insert a row stamped with a tenant its session is not scoped to
      // (the WITH CHECK arm of the same single-dimension policy).
      const anchorInsert = scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        await tx`
          insert into ledger_anchors (id, tenant_id, warehouse_id, from_seq, to_seq, digest, anchored_at)
          values (${uuidv7()}, ${otherTenant}, ${uuidv7()}, 1, 1, ${'a'.repeat(64)}, now())
        `;
      });
      await expect(anchorInsert).rejects.toThrow(/row-level security/i);
    } finally {
      await scoped?.end();
      await admin.end();
    }
  });

  it('cross-tenant: a session from another tenant is 403 on both inventory endpoints, with nothing persisted', async () => {
    const before = await eventCount();
    // A real second tenant (registration + sign-in), not a forged token.
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Other Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    createdTenantIds.push(registered.body.tenant.id as string);
    const otherToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;

    // POST naming the FIRST tenant: rejected before any write.
    const deniedAdjust = await adjust(otherToken, adjustmentBody({ quantityDelta: 1 })).expect(403);
    expect(deniedAdjust.body).toMatchObject({ status: 403, code: 'permission-denied' });
    expect(deniedAdjust.body.detail).toContain('tenant');
    // GET of the first tenant's timeline under the other tenant's session.
    const deniedList = await listEvents(otherToken).expect(403);
    expect(deniedList.body).toMatchObject({ status: 403, code: 'permission-denied' });
    expect(await eventCount()).toBe(before);
  });

  it('malformed occurredAt (no Z suffix) is 400 validation-failed with nothing persisted', async () => {
    const before = await eventCount();
    const res = await adjust(
      opsToken,
      adjustmentBody({ quantityDelta: 1, occurredAt: '2026-01-01T00:00:00' }),
    ).expect(400);
    expect(res.body).toMatchObject({ status: 400, code: 'validation-failed' });
    expect(res.body.detail).toContain('occurredAt');
    expect(await eventCount()).toBe(before);
  });

  it('zero quantityDelta is 400 validation-failed with nothing persisted', async () => {
    const before = await eventCount();
    const res = await adjust(opsToken, adjustmentBody({ quantityDelta: 0 })).expect(400);
    expect(res.body).toMatchObject({ status: 400, code: 'validation-failed' });
    expect(res.body.detail).toContain('non-zero');
    expect(await eventCount()).toBe(before);
  });

  it('quantityDelta beyond int4 is 400 validation-failed at the route bounds, never a 500', async () => {
    const before = await eventCount();
    const res = await adjust(opsToken, adjustmentBody({ quantityDelta: 2147483648 })).expect(400);
    expect(res.body).toMatchObject({ status: 400, code: 'validation-failed' });
    expect(await eventCount()).toBe(before);
  });

  it(
    'idempotency race: a concurrent same-key submit collides on the unique key as 409 conflict',
    async () => {
    const key = ulid();
    const before = await eventCount();
    // A second connection holds an UNCOMMITTED insert on the same
    // (tenant_id, key): the command's INSERT (it saw no committed row)
    // blocks on the unique index until the holder settles, then collides
    // → 23505 → 409.
    const blocker = postgres(process.env.DATABASE_URL!, { max: 1 });
    const watcher = postgres(process.env.DATABASE_URL!, { max: 1 });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const holding = blocker.begin(async (tx) => {
        await tx`
          insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot)
          values (${uuidv7()}, ${tenantId}, ${key}, 'held-by-race-probe', '{}')
        `;
        await gate;
      });
      // Fire the twin request and wait until its idempotency INSERT is
      // PROVABLY blocked on the holder's uncommitted key (a Lock waiter
      // on the idempotency statement — the holder's own connection sits
      // idle-in-transaction, so the signal is unambiguous), then settle
      // the holder. Its INSERT re-checks the now-committed key → 23505.
      const pending = adjust(opsToken, adjustmentBody({ quantityDelta: 1 }), key);
      // supertest is lazy until its first .then/.end — kick the request
      // now so its INSERT actually races the holder.
      void pending.then(() => undefined, () => undefined);
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
        const rows = await watcher`
          select count(*)::int as n from pg_stat_activity
          where wait_event_type = 'Lock' and query ilike '%insert into%idempotency_keys%'
        `;
        blocked = Number((rows[0] as { n: number }).n) >= 1;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(blocked).toBe(true);
      release();
      await holding;
      const res = await pending.expect(409);
      expect(res.body).toMatchObject({ status: 409, code: 'conflict' });
      expect(await eventCount()).toBe(before);
    } finally {
      release();
      await watcher.end();
      await blocker.end();
    }
    }, 30000,
  );

  it('TRUNCATE on both ledger tables is rejected by the statement-level append-only triggers', async () => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await expect(sql.unsafe('truncate ledger_events')).rejects.toThrow(/append-only/i);
      await expect(sql.unsafe('truncate ledger_anchors')).rejects.toThrow(/append-only/i);
    } finally {
      await sql.end();
    }
  });

  it('ledger_anchors append-only: UPDATE and DELETE are rejected and the row is unchanged', async () => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`
        select to_seq, digest from ledger_anchors where tenant_id = ${tenantId} limit 1
      `;
      const stored = rows[0] as { to_seq: number; digest: string };
      await expect(sql`
        update ledger_anchors set digest = ${'f'.repeat(64)}
        where tenant_id = ${tenantId} and to_seq = ${stored.to_seq}
      `).rejects.toThrow(/append-only/i);
      await expect(sql`
        delete from ledger_anchors where tenant_id = ${tenantId} and to_seq = ${stored.to_seq}
      `).rejects.toThrow(/append-only/i);
      const after = await sql`
        select digest from ledger_anchors where tenant_id = ${tenantId} and to_seq = ${stored.to_seq}
      `;
      expect((after[0] as { digest: string }).digest).toBe(stored.digest);
    } finally {
      await sql.end();
    }
  });

  it('DELETE tamper probe: a deleted event inside an explicit range is a chain break naming the missing seq', async () => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    let deletedSeq: number;
    try {
      // The replication-role bypass (the cleanup/tamper mechanism) is the
      // one way rows vanish — exactly what the contiguity check exists for.
      await sql.unsafe('set session_replication_role = replica');
      const target = await sql`
        select seq from ledger_events
        where tenant_id = ${tenantId} and seq > 1 order by seq limit 1
      `;
      deletedSeq = (target[0] as { seq: number }).seq;
      await sql`
        delete from ledger_events where tenant_id = ${tenantId} and seq = ${deletedSeq}
      `;
    } finally {
      await sql.end();
    }
    // The original highest seq still names the requested range.
    const last = (await eventCount()) + 1;
    const report = await facade.verifyChain(tenantId, warehouseId, 1, last);
    expect(report.ok).toBe(false);
    if (report.ok === false) {
      expect(report.reason).toContain(`missing events in seq range 1..${last}`);
      expect(report.fromSeq).toBe(1);
      expect(report.toSeq).toBe(last);
    }
    expect(deletedSeq).toBeGreaterThan(0);
  });
});