import postgres from 'postgres';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';

// The e2e suite talks to the real Postgres (docker-compose dev DB by default;
// CI provides the service container) and signs sessions — the sibling suites'
// conventions (story 5-6: the sync-report upload + the Conflicts & Reviews
// queue's three arms).
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
// The pick.record apply arm rides a real order → wave release path, whose ATP
// grant reads Valkey and fails closed without it — the sibling suites' URL.
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
// No background worker may race these tests — the sibling suites' convention.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

jest.setTimeout(120_000);

// The recount arm's mint feeds the count core's clock invariants nowhere —
// but the upload's op timestamps must parse: a fixed instant off the clock.
const ENQUEUED_AT = new Date(Date.now() - 60_000).toISOString();

function reportRow(opType: string, payload: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    opId: ulid(),
    opType,
    classification: 'rejected',
    problemCode: 'epoch-conflict',
    problemDetail: 'The bin moved under the count (epoch bumped)',
    payload,
    attribution: { deviceLabel: 'Dock scanner 1', operatorEmail: 'floor-op@example.com' },
    opEnqueuedAt: ENQUEUED_AT,
    opOccurredAt: null,
    ...overrides,
  };
}

function transferOpRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return reportRow(
    'transfer.confirm',
    { transferId: uuidv7(), destBinId: uuidv7(), binStateEpoch: 4 },
    overrides,
  );
}

function packOpRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return reportRow(
    'pack.execute',
    { orderId: uuidv7(), scanned: [{ barcode: 'SKU-1-M' }, { barcode: 'SKU-1-M' }] },
    { classification: 'quarantined', problemCode: 'kit-cannot-hold-stock', ...overrides },
  );
}

function pickOpRow(
  warehouseId: string,
  binId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return reportRow(
    'pick.record',
    {
      warehouseId,
      picklistId: uuidv7(),
      picklistLineId: uuidv7(),
      skuId: uuidv7(),
      binId,
      qty: 2,
      binStateEpoch: 7,
    },
    { classification: 'quarantined', problemCode: 'epoch-conflict', ...overrides },
  );
}

describe('the rejected-op sync report + the Conflicts & Reviews queue (story 5-6, e2e)', () => {
  let app: INestApplication;
  const createdTenantIds: string[] = [];

  let suiteDb: SuiteDatabase;

  beforeAll(async () => {
    // infra-1: this suite owns its own database (cloned from the template).
    suiteDb = await useSuiteDatabase('review_reports');
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
    await suiteDb.drop();
  });

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      // FK-safe order: the queue rows and the arms' writes first, then the
      // devices/users the columns reference, then the tenants.
      await sql.unsafe('DELETE FROM rejected_ops WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM count_task_lines WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM count_tasks WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM qc_holds WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM temperature_excursions WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      // `ledger_events` is append-only (a trigger rejects every DELETE,
      // UPDATE and TRUNCATE) — the teardown disables the guard for its own
      // rows only and re-enables it (the rate.spec.ts pattern).
      await sql.unsafe('ALTER TABLE ledger_events DISABLE TRIGGER ledger_events_append_only');
      try {
        await sql.unsafe('DELETE FROM ledger_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      } finally {
        await sql.unsafe('ALTER TABLE ledger_events ENABLE TRIGGER ledger_events_append_only');
      }
      await sql.unsafe('DELETE FROM stock_on_hand WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM bin_state_epochs WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM outbox_messages WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM catalog_import_errors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM catalog_imports WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM uom_conversions WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM kit_compositions WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
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

  async function registerTenant(email: string): Promise<{ tenantId: string; ownerId: string }> {
    const res = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Review Co ${email.split('@')[0]}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    createdTenantIds.push(res.body.tenant.id);
    return { tenantId: res.body.tenant.id as string, ownerId: res.body.owner.id as string };
  }

  async function signIn(email: string, password = 'correct-horse-battery'): Promise<string> {
    const res = await request(app.getHttpServer()).post(`${API}/sign-in`).send({ email, password }).expect(200);
    return res.body.accessToken as string;
  }

  /** Invite + accept + sign-in: one active team member. */
  async function createMember(
    ownerToken: string,
    tenantId: string,
    role: string,
  ): Promise<{ userId: string; email: string; token: string }> {
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
      .send({ token: invited.body.inviteToken, password: 'team-member-password' })
      .expect(200);
    const token = await signIn(email, 'team-member-password');
    return { userId: invited.body.user.id as string, email, token };
  }

  async function enrollDevice(
    ownerToken: string,
    tenantId: string,
    label: string,
  ): Promise<{ deviceId: string; deviceToken: string }> {
    const minted = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(201);
    const enrolled = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label, pin: '1357' })
      .expect(201);
    return { deviceId: enrolled.body.device.id as string, deviceToken: enrolled.body.deviceToken as string };
  }

  async function badgeInOperator(
    tenantId: string,
    deviceToken: string,
    email: string,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({ operatorEmail: email, pin: '1357' })
      .expect(200);
    return res.body.accessToken as string;
  }

  function uploadReport(
    tenantId: string,
    sessionToken: string,
    rows: Record<string, unknown>[],
    idempotencyKey = ulid(),
  ): request.Test {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/sync-reports`)
      .set('Authorization', `Bearer ${sessionToken}`)
      .set(KEY_HEADER, idempotencyKey)
      .send({ rows });
  }

  function listRejectedOps(
    token: string,
    tenantId: string,
    query: Record<string, unknown> = {},
  ): request.Test {
    return request(app.getHttpServer())
      .get(`${API}/${tenantId}/rejected-ops`)
      .query(query)
      .set('Authorization', `Bearer ${token}`);
  }

  function resolveOp(
    token: string,
    tenantId: string,
    rejectedOpId: string,
    body: Record<string, unknown>,
    idempotencyKey = ulid(),
  ): request.Test {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/rejected-ops/${rejectedOpId}/resolve`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, idempotencyKey)
      .send(body);
  }

  async function createWarehouseAndBin(
    ownerToken: string,
    tenantId: string,
    binCode = 'A-01-01',
  ): Promise<{ warehouseId: string; binId: string }> {
    const warehouseId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          origin: testAddress(),
          code: `RR-${ulid().slice(10, 16).toUpperCase()}`,
          name: 'Review WH',
        })
        .expect(201)
    ).body.id as string;
    const zoneId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Zone A' })
        .expect(201)
    ).body.id as string;
    const binId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 1000, type: 'shelf', code: binCode })
        .expect(201)
    ).body.id as string;
    return { warehouseId, binId };
  }

  async function outboxRows(tenantId: string): Promise<{ type: string; payload: Record<string, unknown> }[]> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      return await sql<{ type: string; payload: Record<string, unknown> }[]>`
        select type, payload from outbox_messages where tenant_id = ${tenantId} order by created_at, id`;
    } finally {
      await sql.end();
    }
  }

  async function auditRows(tenantId: string): Promise<{ action: string; reference: string | null }[]> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      return await sql<{ action: string; reference: string | null }[]>`
        select action, reference from audit_events where tenant_id = ${tenantId} order by occurred_at, id`;
    } finally {
      await sql.end();
    }
  }

  /** One plain SKU through the catalog import (the queue's own fixtures). */
  async function importSku(ownerToken: string, tenantId: string, code: string): Promise<string> {
    const csv =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,catch_weight_tracked,reorder_point,reorder_qty,barcode,abc_class' +
      '\n' +
      `${code},Review Plain,pcs,,1800,,false,false,false,,,,a`;
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
    const found = (skus.body.items as { code: string; id: string }[]).find((item) => item.code === code);
    expect(found).toBeTruthy();
    return found!.id;
  }

  /** One tenant + owner + enrolled device + badged operator, ready to upload. */
  async function setupReportingTenant(): Promise<{
    tenantId: string;
    ownerId: string;
    ownerToken: string;
    deviceId: string;
    deviceToken: string;
    operator: { userId: string; email: string; token: string };
    badgeSession: string;
  }> {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId, ownerId } = await registerTenant(email);
    const ownerToken = await signIn(email);
    const operator = await createMember(ownerToken, tenantId, 'operator');
    const device = await enrollDevice(ownerToken, tenantId, 'Replay scanner');
    const badgeSession = await badgeInOperator(tenantId, device.deviceToken, operator.email);
    return { tenantId, ownerId, ownerToken, deviceId: device.deviceId, deviceToken: device.deviceToken, operator, badgeSession };
  }

  test('the sync report records dropped ops, dedupes the re-posted rows, replays with the same key, and 422s a reused key', async () => {
    const { tenantId, ownerToken, operator, badgeSession } = await setupReportingTenant();

    const rowA = transferOpRow();
    // The batch mixes the op sessions: rowB's own sealed attribution is
    // deliberately DIFFERENT from rowA's — the per-row stamp (the ratified
    // per-card decision) is pinned below by cardB carrying its own, never
    // rows[0]'s.
    const rowB = packOpRow({ attribution: { deviceLabel: 'Dock scanner 2', operatorEmail: 'other-op@example.com' } });
    const key = ulid();
    const first = await uploadReport(tenantId, badgeSession, [rowA, rowB], key).expect(201);
    expect(first.body).toEqual({ received: 2, recorded: 2, duplicates: 0, rows: [{ opId: rowA.opId, recorded: true }, { opId: rowB.opId, recorded: true }] });

    // The upload is audited + outboxed exactly once (action + reference = key).
    const audits = await auditRows(tenantId);
    expect(audits.filter((a) => a.action === 'device.sync_report.recorded')).toHaveLength(1);
    expect(audits.find((a) => a.action === 'device.sync_report.recorded')!.reference).toBe(key);
    // The upload is AUDIT-ONLY (the frozen contract: outbox events ride the
    // resolve arms) — no device.sync_report.recorded outbox event exists.
    const events = await outboxRows(tenantId);
    expect(events.filter((e) => e.type === 'device.sync_report.recorded')).toHaveLength(0);

    // The same rows under a FRESH key: the (tenant, op_id) pair absorbs them —
    // the exact at-least-once dedupe, recorded=false per row.
    const repost = await uploadReport(tenantId, badgeSession, [rowA, rowB], ulid()).expect(201);
    expect(repost.body).toEqual({ received: 2, recorded: 0, duplicates: 2, rows: [{ opId: rowA.opId, recorded: false }, { opId: rowB.opId, recorded: false }] });

    // The same key + the same payload replays the stored snapshot verbatim.
    const replay = await uploadReport(tenantId, badgeSession, [rowA, rowB], key).expect(201);
    expect(replay.body).toEqual(first.body);

    // The same key + a changed payload → idempotency-key-reuse.
    const changed = [transferOpRow({ opId: rowA.opId, problemDetail: 'changed detail' }), rowB];
    const reuse = await uploadReport(tenantId, badgeSession, changed, key).expect(422);
    expect(reuse.body).toMatchObject({ code: 'idempotency-key-reuse' });

    // A PARTIAL re-post (only one of the two rows) is per-row, not per-report.
    const partial = await uploadReport(tenantId, badgeSession, [rowB], ulid()).expect(201);
    expect(partial.body).toEqual({ received: 1, recorded: 0, duplicates: 1, rows: [{ opId: rowB.opId, recorded: false }] });

    // The queue rows carry the stamped attribution: the server-verified
    // reporting session beside the op's OWN session as the device sealed it.
    const listed = await listRejectedOps(ownerToken, tenantId).expect(200);
    expect(listed.body.items).toHaveLength(2);
    const card = listed.body.items.find((i: { opId: string }) => i.opId === rowA.opId);
    expect(card).toMatchObject({
      opType: 'transfer.confirm',
      classification: 'rejected',
      problemCode: 'epoch-conflict',
      status: 'open',
      resolvedBy: null,
      resolvedOutcome: null,
    });
    expect(typeof card!.attribution.deviceId).toBe('string');
    expect(card!.attribution.operatorEmail).toBe(operator.email);
    expect(card!.attribution.opDeviceLabel).toBe('Dock scanner 1');
    expect(card!.attribution.opOperatorEmail).toBe('floor-op@example.com');
    // Per-row stamping (the review's Entry B): rowB carries its OWN seal,
    // beside the SAME server-verified reporting identity.
    const cardB = listed.body.items.find((i: { opId: string }) => i.opId === rowB.opId);
    expect(cardB!.attribution.deviceId).toBe(card!.attribution.deviceId);
    expect(cardB!.attribution.operatorEmail).toBe(operator.email);
    expect(cardB!.attribution.opDeviceLabel).toBe('Dock scanner 2');
    expect(cardB!.attribution.opOperatorEmail).toBe('other-op@example.com');
    // `binStateEpoch` was uploaded inside the payload but nothing strips it on
    // the UPLOAD (only the apply arm strips it at re-execution time).
    expect(card!.payload.binStateEpoch).toBe(4);
  });

  test('the sync report refuses malformed rows (self-test echo, wrong shapes, attribution keys, budget) and a bare credential', async () => {
    const { tenantId, ownerToken, badgeSession, deviceToken } = await setupReportingTenant();

    // A self-test echo is device diagnostics, never a reviewable op — the
    // boundary refuses it explicitly (frozen rule).
    const echo = await uploadReport(tenantId, badgeSession, [
      reportRow('self-test.echo', { kind: 'self-test' }),
    ]).expect(400);
    // (the boundary @IsIn vocabulary refuses it BEFORE the command's own
    // echo-shaped message — defense in depth beneath)
    expect(echo.body.detail).toContain('opType must be one of the following values');
    expect(echo.body.detail).toContain('grn.submit');

    // A malformed op id is 400 naming the row.
    const badId = await uploadReport(tenantId, badgeSession, [reportRow('transfer.confirm', { transferId: uuidv7(), destBinId: uuidv7() }, { opId: 'x'.repeat(26) })]).expect(400);
    expect(badId.body).toMatchObject({ code: 'validation-failed' });
    expect(badId.body.detail).toContain('row 0');

    // A payload missing its op's shape (transfer.confirm without destBinId) is
    // refused BEFORE any write.
    const missing = await uploadReport(tenantId, badgeSession, [reportRow('transfer.confirm', { transferId: uuidv7() })]).expect(400);
    expect(missing.body.detail).toContain('payload.destBinId');

    // An unknown attribution key is refused.
    const stranger = await uploadReport(tenantId, badgeSession, [
      reportRow('pack.execute', { orderId: uuidv7(), scanned: [{}] }, { attribution: { deviceLabel: 'D', forged: 'yes' } }),
    ]).expect(400);
    expect(stranger.body.detail).toContain('forged');

    // A NULL row (review iteration 1, RB6 — pinned at its REAL layer): the
    // DTO's @ValidateNested({each: true}) refuses null array elements itself,
    // with a 400 — never a 500 — naming the array path, not a row (there is
    // no op id in a null to name).
    const nullRow = await uploadReport(tenantId, badgeSession, [null as unknown as Record<string, unknown>]).expect(400);
    expect(nullRow.body).toMatchObject({ code: 'validation-failed' });
    expect(nullRow.body.detail).toContain('rows');
    expect(nullRow.body.detail).toContain('either object or array');

    // A one-row-over budget (the frozen 200) is a boundary validation.
    const flood = Array.from({ length: 201 }, () => packOpRow());
    await uploadReport(tenantId, badgeSession, flood).expect(400);

    // The report carries nothing when nothing was retained.
    await uploadReport(tenantId, badgeSession, []).expect(400);

    // The bare (pre-badge-in) credential cannot upload — badge-in first.
    await uploadReport(tenantId, deviceToken, [packOpRow()]).expect(401);

    // Nothing from this test leaked into the queue. (Read with a WEB session:
    // the queue is a web route, and since story 21-7 a badge-in token no
    // longer satisfies `TenantSessionGuard` — the old one-way hole this read
    // used to ride is closed, both families now exclusive by claim shape.)
    const listed = await listRejectedOps(ownerToken, tenantId).expect(200);
    expect(listed.body.items).toHaveLength(0);
  });

  test('the review queue lists rejected ops with the keyset cursor and the status filter — open to any member, foreign sessions refused', async () => {
    const { tenantId, ownerToken, operator, badgeSession } = await setupReportingTenant();

    // Five rows (the keyset chain's walk needs > pageSize).
    const rows = [
      transferOpRow(),
      packOpRow(),
      transferOpRow(),
      packOpRow(),
      transferOpRow(),
    ];
    await uploadReport(tenantId, badgeSession, rows, ulid()).expect(201);

    // A member read (the operator's own session): open to any tenant member.
    const first = await listRejectedOps(operator.token, tenantId, { limit: 2 }).expect(200);
    expect(first.body.items).toHaveLength(2);
    for (const item of first.body.items as { opId: string }[]) {
      expect(rows.map((r) => r.opId)).toContain(item.opId);
    }

    // The chain walks to exhaustion without duplicates or gaps.
    const seen: string[] = [...first.body.items.map((i: { opId: string }) => i.opId)];
    let cursor: string | null = first.body.nextCursor as string | null;
    for (let hop = 0; cursor !== null; hop++) {
      expect(hop).toBeLessThan(10);
      const page = await listRejectedOps(operator.token, tenantId, { limit: 2, cursor }).expect(200);
      seen.push(...page.body.items.map((i: { opId: string }) => i.opId));
      cursor = page.body.nextCursor as string | null;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(rows.map((r) => r.opId)));

    // The discard arm changes the row's status; the status filter follows.
    const page = await listRejectedOps(ownerToken, tenantId, { limit: 1 }).expect(200);
    const victim = page.body.items[0];
    await resolveOp(ownerToken, tenantId, victim.id, { decision: 'discard' }, ulid()).expect(200);
    const openOnly = (await listRejectedOps(ownerToken, tenantId, { status: 'open' }).expect(200)).body;
    expect(openOnly.items.map((i: { opId: string }) => i.opId)).not.toContain(victim.opId);
    const discarded = (await listRejectedOps(ownerToken, tenantId, { status: 'discarded' }).expect(200)).body;
    expect(discarded.items.map((i: { opId: string }) => i.opId)).toEqual([victim.opId]);
    expect(discarded.items[0].resolvedOutcome).toEqual({ kind: 'discard' });

    // A crafted cursor and an unknown status filter are 400s.
    await listRejectedOps(ownerToken, tenantId, { cursor: 'not-a-real-cursor' }).expect(400);
    const badStatus = await listRejectedOps(ownerToken, tenantId, { status: 'pending' }).expect(400);
    expect(badStatus.body).toMatchObject({ code: 'validation-failed' });

    // The limit's documented 400 arm is REACHABLE (the DTO's @IsNumber + the
    // 1..200 bounds — the review's Entry E): `limit=abc` (a NaN past the wire
    // transform) and out-of-range values are boundary refusals, never a NaN
    // reaching the command's clamp and the database as a 500.
    for (const badLimit of [{ limit: 'abc' }, { limit: 0 }, { limit: 201 }]) {
      await listRejectedOps(ownerToken, tenantId, badLimit).expect(400);
    }

    // A foreign session is refused (the tenant-scope guard).
    const otherEmail = `owner-${ulid().toLowerCase()}@example.com`;
    await registerTenant(otherEmail);
    const tokenB = await signIn(otherEmail);
    const cross = await listRejectedOps(tokenB, tenantId).expect(403);
    expect(cross.body).toMatchObject({ code: 'permission-denied' });
  });

  test('the discard arm settles the row, trails audit + outbox, replays idempotent; a second resolve 409s and a reused key 422s', async () => {
    const { tenantId, ownerId, ownerToken, badgeSession } = await setupReportingTenant();
    const row = transferOpRow();
    await uploadReport(tenantId, badgeSession, [row], ulid()).expect(201);
    const { items } = (await listRejectedOps(ownerToken, tenantId).expect(200)).body;
    const open = items.find((i: { opId: string }) => i.opId === row.opId);
    expect(open.status).toBe('open');

    // An operator holds no review.decide — the resolution is refused and the
    // row stays open for the owner's arm below.
    const operator = await createMember(ownerToken, tenantId, 'operator');
    const denied = await resolveOp(operator.token, tenantId, open.id, { decision: 'discard' }).expect(403);
    expect(denied.body).toMatchObject({ status: 403, code: 'role-denied' });
    expect(denied.body.detail).toContain('review.decide');

    // The discard itself: 200, the row leaves the open set, outcome stamped.
    const key = ulid();
    const done = await resolveOp(ownerToken, tenantId, open.id, { decision: 'discard' }, key).expect(200);
    expect(done.body.rejectedOp).toMatchObject({
      id: open.id,
      status: 'discarded',
      resolvedBy: ownerId,
      resolvedOutcome: { kind: 'discard' },
    });
    expect(done.body.rejectedOp.resolvedAt).toBeTruthy();
    expect(done.body.outcome).toEqual({ kind: 'discard' });

    // A second resolve on the terminal row → 409 rejected-op-resolved.
    const again = await resolveOp(ownerToken, tenantId, open.id, { decision: 'apply' }, ulid()).expect(409);
    expect(again.body).toMatchObject({ code: 'rejected-op-resolved' });

    // The same key replays the stored resolution (state-check order: the
    // idempotency replay precedes the state machine).
    const replay = await resolveOp(ownerToken, tenantId, open.id, { decision: 'discard' }, key).expect(200);
    expect(replay.body).toEqual(done.body);

    // The same key + a different decision → idempotency-key-reuse.
    const reuse = await resolveOp(ownerToken, tenantId, open.id, { decision: 'apply' }, key).expect(422);
    expect(reuse.body).toMatchObject({ code: 'idempotency-key-reuse' });

    // Exactly one audit row + outbox event, payload echoing the resolution.
    const audits = await auditRows(tenantId);
    const resolved = audits.filter((a) => a.action === 'device.rejected_op.resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.reference).toBe(key);
    const events = await outboxRows(tenantId);
    const resolvedEvents = events.filter((e) => e.type === 'device.rejected_op.resolved');
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0]!.payload as Record<string, unknown>).toMatchObject({
      rejectedOpId: open.id,
      opId: row.opId,
      opType: 'transfer.confirm',
      decision: 'discard',
      status: 'discarded',
      resolvedBy: ownerId,
    });

    // An unknown id is a clean 404.
    const ghost = await resolveOp(ownerToken, tenantId, uuidv7(), { decision: 'discard' }).expect(404);
    expect(ghost.body).toMatchObject({ code: 'not-found' });
  });

  test('the recount arm mints a count task through the movement core; the open-task rule (409) and a bin-less payload (400) and a foreign bin (404) refuse verbatim', async () => {
    const { tenantId, ownerToken, badgeSession } = await setupReportingTenant();
    const { warehouseId, binId } = await createWarehouseAndBin(ownerToken, tenantId, 'A-01-01');

    // A quarantined pick op names the real bin.
    const row = pickOpRow(warehouseId, binId);
    await uploadReport(tenantId, badgeSession, [row], ulid()).expect(201);
    let { items } = (await listRejectedOps(ownerToken, tenantId, { status: 'open' }).expect(200)).body;
    const pick = items.find((i: { opId: string }) => i.opId === row.opId)!;

    const key = ulid();
    const recounted = await resolveOp(ownerToken, tenantId, pick.id, { decision: 'recount' }, key).expect(200);
    expect(recounted.body.rejectedOp.status).toBe('recounted');
    const countTaskId = recounted.body.outcome.countTaskId as string;
    expect(typeof countTaskId).toBe('string');
    const replay = await resolveOp(ownerToken, tenantId, pick.id, { decision: 'recount' }, key).expect(200);
    expect(replay.body).toEqual(recounted.body);

    // The mint went through the movement recount core: origin recount,
    // createdBy null, the `count.created` outbox event.
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const tasks = await sql<{ id: string; origin: string; created_by: string | null; bin_id: string }[]>`
        select id, origin, created_by, bin_id from count_tasks where tenant_id = ${tenantId}`;
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ id: countTaskId, origin: 'recount', created_by: null, bin_id: binId });
    } finally {
      await sql.end();
    }
    const events = await outboxRows(tenantId);
    expect(
      events.filter((e) => e.type === 'count.created' && (e.payload as Record<string, unknown>).origin === 'recount'),
    ).toHaveLength(1);

    // The open-task-per-bin rule holds on the review surface too: a second
    // recount against the SAME bin is 409 count-task-open — verbatim from the
    // count core — and its row STAYS open.
    const secondRow = pickOpRow(warehouseId, binId);
    await uploadReport(tenantId, badgeSession, [secondRow], ulid()).expect(201);
    ({ items } = (await listRejectedOps(ownerToken, tenantId, { status: 'open' }).expect(200)).body);
    const second = items.find((i: { opId: string }) => i.opId === secondRow.opId);
    const refused = await resolveOp(ownerToken, tenantId, second.id, { decision: 'recount' }, ulid()).expect(409);
    expect(refused.body).toMatchObject({ code: 'count-task-open' });
    const stillOpen = (await listRejectedOps(ownerToken, tenantId, { status: 'open' }).expect(200)).body;
    expect(stillOpen.items.map((i: { opId: string }) => i.opId)).toContain(second.opId);
    expect(stillOpen.items.find((i: { opId: string }) => i.opId === second.opId)!.problemCode).toBe('epoch-conflict');

    // A bin-less payload (pack) is a direct-request backstop 400 — the arm is
    // hidden client-side, never a served 409.
    const packRow = packOpRow();
    await uploadReport(tenantId, badgeSession, [packRow], ulid()).expect(201);
    ({ items } = (await listRejectedOps(ownerToken, tenantId, { status: 'open' }).expect(200)).body);
    const packOp = items.find((i: { opId: string }) => i.opId === packRow.opId);
    const binless = await resolveOp(ownerToken, tenantId, packOp.id, { decision: 'recount' }, ulid()).expect(400);
    expect(binless.body).toMatchObject({ code: 'validation-failed' });
    expect(binless.body.detail).toContain('no count task can be minted');

    // A well-formed bin id that does not exist → 404.
    const ghostRow = pickOpRow(warehouseId, uuidv7());
    await uploadReport(tenantId, badgeSession, [ghostRow], ulid()).expect(201);
    ({ items } = (await listRejectedOps(ownerToken, tenantId, { status: 'open' }).expect(200)).body);
    const ghost = items.find((i: { opId: string }) => i.opId === ghostRow.opId);
    const unknownBin = await resolveOp(ownerToken, tenantId, ghost.id, { decision: 'recount' }, ulid()).expect(404);
    expect(unknownBin.body).toMatchObject({ code: 'not-found' });
    expect(unknownBin.body.detail).toContain('No bin with id');

    // RV2 (review iteration 1): the PUTAWAY carrier — the arm's second
    // vocabulary half. A `putaway.place` row whose payload names NO `binId`,
    // only the placement field `toBinId` (the real mobile outbox's placement
    // payload shape, its own warehouse + bin), counts: the arm resolves the
    // bin from `payload.toBinId` against the payload's OWN warehouse and
    // mints the task on THAT bin.
    const putawayTarget = await createWarehouseAndBin(ownerToken, tenantId, 'A-01-02');
    const putawayCountRow = reportRow('putaway.place', {
      warehouseId: putawayTarget.warehouseId,
      grnId: uuidv7(),
      grnLineId: uuidv7(),
      skuId: uuidv7(),
      batchId: null,
      qty: 6,
      toBinId: putawayTarget.binId,
      reasonCode: null,
      occurredAt: ENQUEUED_AT,
      serials: null,
    });
    await uploadReport(tenantId, badgeSession, [putawayCountRow], ulid()).expect(201);
    ({ items } = (await listRejectedOps(ownerToken, tenantId, { status: 'open' }).expect(200)).body);
    const putawayCount = items.find((i: { opId: string }) => i.opId === putawayCountRow.opId)!;
    const toBinRecount = await resolveOp(ownerToken, tenantId, putawayCount.id, { decision: 'recount' }, ulid()).expect(200);
    expect(toBinRecount.body.rejectedOp.status).toBe('recounted');
    const toBinTaskId = toBinRecount.body.outcome.countTaskId as string;
    expect(typeof toBinTaskId).toBe('string');
    const sql2 = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const tasks = await sql2<{ bin_id: string; origin: string }[]>`
        select bin_id, origin from count_tasks where tenant_id = ${tenantId} and id = ${toBinTaskId}`;
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ bin_id: putawayTarget.binId, origin: 'recount' });
    } finally {
      await sql2.end();
    }
  });

  /** Seeds on-hand with a stock-count adjustment (the picking suite's fixture). */
  async function seedStock(
    ownerToken: string,
    tenantId: string,
    warehouseId: string,
    skuId: string,
    binId: string,
    quantity: number,
  ): Promise<void> {
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId, binId, quantityDelta: quantity, reasonCode: 'stock-count', note: 'review-reports seed' })
      .expect(201);
    // The order create's ATP grant reads Valkey counters; a warehouse that
    // has never granted has no ready marker, so the FIRST grant fails closed
    // (the not-ready arm rebuilds only for the NEXT grant) — the sibling
    // suites' convention: seed → rebuild → then reserve.
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);
  }

  async function onHandMilli(tenantId: string, skuId: string, binId: string): Promise<number> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql<{ quantity: string }[]>`
        select coalesce(sum(quantity), 0)::text as quantity from stock_on_hand
        where tenant_id = ${tenantId} and sku_id = ${skuId} and bin_id = ${binId}`;
      return Number(rows[0]!.quantity);
    } finally {
      await sql.end();
    }
  }

  test('the apply arm covers the remaining op types end to end — count.submit, pick.record, pack.execute, transfer.confirm and excursion.record each settle real state through their own command (the review\'s Entry H)', async () => {
    const { tenantId, ownerToken, badgeSession } = await setupReportingTenant();
    const { warehouseId, binId } = await createWarehouseAndBin(ownerToken, tenantId, 'A-01-01');
    const { warehouseId: destWarehouseId, binId: bin2 } = await createWarehouseAndBin(ownerToken, tenantId, 'A-01-02');
    const skuId = await importSku(ownerToken, tenantId, 'RR-APPLY-SKU');
    await seedStock(ownerToken, tenantId, warehouseId, skuId, binId, 10);

    const items = (await listRejectedOps(ownerToken, tenantId).expect(200)).body.items;
    expect(items).toHaveLength(0);

    const uploadOpenRow = async (row: Record<string, unknown>): Promise<{ id: string; status: string }> => {
      await uploadReport(tenantId, badgeSession, [row], ulid()).expect(201);
      const listing = (await listRejectedOps(ownerToken, tenantId, { status: 'open' }).expect(200)).body;
      return listing.items.find((i: { opId: string }) => i.opId === row.opId);
    };

    // ── (1) count.submit: the task created BEFORE any movement freezes the
    // bin's epoch and its one expected arm; the apply re-executes the submit
    // through the count core and the epoch EQUALITY still holds (no movement
    // between) — the task completes and the variance row opens.
    const task = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/movements/counts`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, binId })
        .expect(201)
    ).body.countTask as { id: string };
    const countRow = reportRow('count.submit', {
      taskId: task.id,
      lines: [{ skuId, countedQuantity: 12 }],
    }, { problemCode: 'count-line-epoch' });
    const countOp = await uploadOpenRow(countRow);
    const countResolve = await resolveOp(ownerToken, tenantId, countOp.id, { decision: 'apply' }, ulid()).expect(200);
    expect(countResolve.body.rejectedOp.status).toBe('applied');
    expect(countResolve.body.outcome.command).toBe('count.submit');
    const sql1 = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const row1 = await sql1<{ status: string; counted_quantity_milli: string | null }[]>`
        select status from count_tasks where id = ${task.id}`;
      expect(row1[0]).toMatchObject({ status: 'completed' });
    } finally {
      await sql1.end();
    }

    // ── (2) pick.record: the real order/wave fixture; the apply draws the
    // units (binStateEpoch stripped — the human judgment replaces the
    // observation), the stock leaves the bin.
    const orderId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/outbound/orders`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, lines: [{ skuId, quantity: 4 }], destination: testAddress() })
        .expect(201)
    ).body.order.id as string;
    const policyId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/outbound/wave-policies`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, name: `rr-${ulid().slice(10, 18)}`, grouping: 'single' })
        .expect(201)
    ).body.policy.id as string;
    const waveId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/outbound/waves`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, policyId, orderIds: [orderId] })
        .expect(201)
    ).body.wave.id as string;
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves/${waveId}/release`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const wave = (
      await request(app.getHttpServer())
        .get(`${API}/${tenantId}/outbound/waves/${waveId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200)
    ).body.wave as { picklists: { id: string; lines: { id: string; binId: string | null }[] }[] };
    const pickLine = wave.picklists[0]!.lines[0]!;
    const pickRow = reportRow('pick.record', {
      warehouseId,
      picklistId: wave.picklists[0]!.id,
      picklistLineId: pickLine.id,
      skuId,
      binId: pickLine.binId ?? binId,
      qty: 4,
      binStateEpoch: 9, // the staleness token — dropped at APPLY
    }, { problemCode: 'epoch-conflict' });
    const pickOp = await uploadOpenRow(pickRow);
    const pickResolve = await resolveOp(ownerToken, tenantId, pickOp.id, { decision: 'apply' }, ulid()).expect(200);
    expect(pickResolve.body.rejectedOp.status).toBe('applied');
    expect(pickResolve.body.outcome.command).toBe('pick.record');
    expect(await onHandMilli(tenantId, skuId, binId)).toBe(6_000); // 10 drawn 4, milli

    // ── (3) pack.execute on the SAME order: the scanned set matches what the
    // applied pick drew; the command's device re-authorization names the
    // reported device (still active — the badge-in session's own row).
    const packRow = reportRow('pack.execute', {
      orderId,
      scanned: [{ skuId, qty: 4 }],
    }, { problemCode: 'epoch-conflict' });
    const packOp = await uploadOpenRow(packRow);
    const packResolve = await resolveOp(ownerToken, tenantId, packOp.id, { decision: 'apply' }, ulid()).expect(200);
    expect(packResolve.body.rejectedOp.status).toBe('applied');
    expect(packResolve.body.outcome.command).toBe('pack.execute');
    expect(packResolve.body.outcome.snapshot.pack.orderStatus).toBe('ready_to_dispatch');

    // ── (4) transfer.confirm: the draft is planned and confirmed outbound at
    // the tenant surface (the planner verb), the parked units are real
    // IN-TRANSIT stock, and the apply re-executes the DEVICE op — its
    // inbound lands the two units in the second bin.
    const transfer = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/movements/transfers`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          sourceWarehouseId: warehouseId,
          destWarehouseId,
          note: 'review-reports transfer',
          lines: [{ skuId, quantity: 2, fromBinId: binId, toBinId: bin2 }],
        })
        .expect(201)
    ).body.transfer as { id: string };
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/movements/transfers/${transfer.id}/outbound-confirm`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const transferRow = reportRow('transfer.confirm', {
      transferId: transfer.id,
      destBinId: bin2,
    }, { problemCode: 'transfer-bin-changed' });
    const transferOp = await uploadOpenRow(transferRow);
    const transferResolve = await resolveOp(ownerToken, tenantId, transferOp.id, { decision: 'apply' }, ulid()).expect(200);
    expect(transferResolve.body.rejectedOp.status).toBe('applied');
    expect(transferResolve.body.outcome.command).toBe('transfer.confirm');
    expect(transferResolve.body.outcome.snapshot.transfer.status).toBe('completed');
    expect(await onHandMilli(tenantId, skuId, bin2)).toBe(2_000);

    // ── (5) excursion.record on the bin the transfer just landed: the sweep
    // quarantines its real stock — the QC hold is born through the command,
    // never a direct write.
    const excursionRow = reportRow('excursion.record', {
      warehouseId: destWarehouseId,
      binId: bin2,
      readingC: 9.5,
      note: 'review-reports excursion',
    }, { problemCode: 'cold-chain' });
    const excursionOp = await uploadOpenRow(excursionRow);
    const excursionResolve = await resolveOp(ownerToken, tenantId, excursionOp.id, { decision: 'apply' }, ulid()).expect(200);
    expect(excursionResolve.body.rejectedOp.status).toBe('applied');
    expect(excursionResolve.body.outcome.command).toBe('excursion.record');
    const sql5 = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const holds = await sql5<{ status: string }[]>`
        select status from qc_holds where tenant_id = ${tenantId} and bin_id = ${bin2}`;
      expect(holds.length).toBeGreaterThan(0);
      expect(holds[0]).toMatchObject({ status: 'open' });
      const orders = await sql5<{ status: string }[]>`
        select status from orders where id = ${orderId}`;
      expect(orders[0]).toMatchObject({ status: 'ready_to_dispatch' });
      const countVariances = await sql5<{ delta_milli: string }[]>`
        select delta_milli from count_variances where task_id = ${task.id}`;
      expect(countVariances).toHaveLength(1);
      expect(Number(countVariances[0]!.delta_milli)).toBe(2_000); // counted 12 − expected 10, milli
    } finally {
      await sql5.end();
    }

    // Five applied rows settled through five different owning commands —
    // five audit rows, five outbox events, one attribution each.
    const audits = await auditRows(tenantId);
    expect(audits.filter((a) => a.action === 'device.rejected_op.resolved')).toHaveLength(5);
    const events = await outboxRows(tenantId);
    const resolvedEvents = events.filter((e) => e.type === 'device.rejected_op.resolved');
    expect(resolvedEvents).toHaveLength(5);
    expect(new Set(resolvedEvents.map((e) => (e.payload as { opId: string }).opId))).toEqual(
      new Set([countRow.opId, pickRow.opId, packRow.opId, transferRow.opId, excursionRow.opId]),
    );
  });

  test('the apply arm re-executes through the owning command: refusals keep the row open with its ORIGINAL refusal; a blind GRN + a putaway apply settle; replay is idempotent', async () => {
    const { tenantId, ownerToken, badgeSession } = await setupReportingTenant();
    const { warehouseId, binId } = await createWarehouseAndBin(ownerToken, tenantId, 'A-01-01');
    const skuId = await importSku(ownerToken, tenantId, 'RR-PLAIN-SKU');

    // (a) The refusal arm: a count op whose task does not exist re-executes
    // through the count core and is refused VERBATIM (its own 404) — the
    // resolution rolls back and the row stays open, still showing its
    // original replay refusal.
    const refusedRow = reportRow('count.submit', {
      taskId: uuidv7(),
      lines: [{ skuId: uuidv7(), countedQuantity: 1 }],
    }, { problemCode: 'count-line-epoch' });
    await uploadReport(tenantId, badgeSession, [refusedRow], ulid()).expect(201);
    let { items } = (await listRejectedOps(ownerToken, tenantId, { status: 'open' }).expect(200)).body;
    const refused = items.find((i: { opId: string }) => i.opId === refusedRow.opId)!;
    const refusedResolve = await resolveOp(ownerToken, tenantId, refused.id, { decision: 'apply' }, ulid()).expect(404);
    expect(refusedResolve.body).toMatchObject({ code: 'not-found' });
    expect(refusedResolve.body.detail).toContain('No count task with this id');
    const afterRefusal = (await listRejectedOps(ownerToken, tenantId, { status: 'open' }).expect(200)).body;
    const stillOpen = afterRefusal.items.find((i: { opId: string }) => i.opId === refusedRow.opId);
    expect(stillOpen).toBeTruthy();
    expect(stillOpen.status).toBe('open');
    expect(stillOpen.problemCode).toBe('count-line-epoch'); // the original refusal, untouched

    // (b) The excursion family's own guard, verbatim: an excursion on an
    // EMPTY bin quarantines the stock it affects — the bin has none, the
    // command refuses 400 and the row stays open.
    const emptyBinRow = reportRow('excursion.record', {
      warehouseId,
      binId,
      readingC: 9.5,
      note: null,
    }, { classification: 'quarantined', problemCode: 'cold-chain' });
    await uploadReport(tenantId, badgeSession, [emptyBinRow], ulid()).expect(201);
    ({ items } = (await listRejectedOps(ownerToken, tenantId, { status: 'open' }).expect(200)).body);
    const emptyOp = items.find((i: { opId: string }) => i.opId === emptyBinRow.opId)!;
    const emptyBinRefusal = await resolveOp(ownerToken, tenantId, emptyOp.id, { decision: 'apply' }, ulid()).expect(400);
    expect(emptyBinRefusal.body).toMatchObject({ code: 'validation-failed' });
    expect(emptyBinRefusal.body.detail).toContain('no on-hand stock');

    // (c) The successful arm — a blind GRN: the payload re-executes through
    // the receiving facade's guarded command, and the command's own snapshot
    // comes back as the outcome.
    const grnRow = reportRow('grn.submit', {
      warehouseId,
      poId: null,
      blindReasonCode: 'unannounced-delivery',
      lines: [{ poLineId: null, skuId, batchCode: null, mfgDate: null, qty: 10, weightsGrams: null }],
    }, { classification: 'rejected', problemCode: 'device-offline', opOccurredAt: ENQUEUED_AT });
    await uploadReport(tenantId, badgeSession, [grnRow], ulid()).expect(201);
    ({ items } = (await listRejectedOps(ownerToken, tenantId, { status: 'open' }).expect(200)).body);
    const grnOp = items.find((i: { opId: string }) => i.opId === grnRow.opId)!;
    const grnKey = ulid();
    const grnResolve = await resolveOp(ownerToken, tenantId, grnOp.id, { decision: 'apply' }, grnKey).expect(200);
    expect(grnResolve.body.rejectedOp.status).toBe('applied');
    expect(grnResolve.body.outcome.kind).toBe('applied');
    expect(grnResolve.body.outcome.command).toBe('grn.submit');
    const grnId = grnResolve.body.outcome.snapshot.goodsReceipt.id as string;
    expect(grnResolve.body.outcome.snapshot.goodsReceipt.lines).toHaveLength(1);
    const grnLineId = grnResolve.body.outcome.snapshot.goodsReceipt.lines[0].id as string;
    expect(grnResolve.body.outcome.snapshot.goodsReceipt.lines[0].appliedQty).toBe(10);

    // The apply is idempotently replayable at the row level: same key, same
    // body; a fresh key on the terminal row is 409.
    const grnReplay = await resolveOp(ownerToken, tenantId, grnOp.id, { decision: 'apply' }, grnKey).expect(200);
    expect(grnReplay.body).toEqual(grnResolve.body);
    await resolveOp(ownerToken, tenantId, grnOp.id, { decision: 'apply' }, ulid()).expect(409);

    // (d) A second op whose payload the OUTCOME composes: the putaway of part
    // of the receipt (the queue card's own snapshot chain is the review UI's
    // work here; the arm consumes the grn id + line id the placement moves).
    const putawayRow = reportRow('putaway.place', {
      warehouseId,
      grnId,
      grnLineId,
      skuId,
      batchId: null,
      qty: 6,
      toBinId: binId,
      reasonCode: null,
    }, { classification: 'rejected', problemCode: 'device-offline', opOccurredAt: ENQUEUED_AT });
    await uploadReport(tenantId, badgeSession, [putawayRow], ulid()).expect(201);
    const listing = (await listRejectedOps(ownerToken, tenantId, { status: 'open' }).expect(200)).body;
    const putawayOp = listing.items.find((i: { opId: string }) => i.opId === putawayRow.opId)!;
    const putawayResolve = await resolveOp(ownerToken, tenantId, putawayOp.id, { decision: 'apply' }, ulid()).expect(200);
    expect(putawayResolve.body.rejectedOp.status).toBe('applied');
    expect(putawayResolve.body.outcome.kind).toBe('applied');
    expect(putawayResolve.body.outcome.command).toBe('putaway.place');

    // The placement moved REAL stock: the shelf bin holds the six units.
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const soh = await sql<{ quantity: string }[]>`
        select quantity from stock_on_hand
        where tenant_id = ${tenantId} and sku_id = ${skuId} and bin_id = ${binId}`;
      expect(soh).toHaveLength(1);
      expect(Number(soh[0]!.quantity)).toBe(6_000); // milli-units (AD-9)
    } finally {
      await sql.end();
    }

    // Exactly one resolve audit + outbox event per applied row (two here: the
    // GRN and the putaway), each naming the resolution.
    const audits = await auditRows(tenantId);
    expect(audits.filter((a) => a.action === 'device.rejected_op.resolved')).toHaveLength(2);
    const events = await outboxRows(tenantId);
    expect(
      events.filter(
        (e) => e.type === 'device.rejected_op.resolved' &&
          [(grnRow.opId as string), (putawayRow.opId as string)].includes((e.payload as { opId: string }).opId),
      ),
    ).toHaveLength(2);

    // No op was double-applied: exactly one GRN for the tenant's blind flow.
    // (A fresh client — the one above was already `.end()`ed.)
    const sql2 = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const grns = await sql2<{ id: string }[]>`
        select id from goods_receipt_notes where tenant_id = ${tenantId}`;
      expect(grns).toHaveLength(1);
    } finally {
      await sql2.end();
    }
  });



  test('resolve authority is review.decide exactly — an ops_manager decides, an operator cannot, a foreign session cannot reach the row', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId } = await registerTenant(email);
    const ownerToken = await signIn(email);
    const opsManager = await createMember(ownerToken, tenantId, 'ops_manager');
    const operator = await createMember(ownerToken, tenantId, 'operator');
    const device = await enrollDevice(ownerToken, tenantId, 'Ops scanner');
    const badgeSession = await badgeInOperator(tenantId, device.deviceToken, operator.email);
    const row = transferOpRow();
    await uploadReport(tenantId, badgeSession, [row], ulid()).expect(201);
    const { items } = (await listRejectedOps(ownerToken, tenantId).expect(200)).body;
    const open = items[0];

    const denied = await resolveOp(operator.token, tenantId, open.id, { decision: 'discard' }).expect(403);
    expect(denied.body).toMatchObject({ code: 'role-denied', status: 403 });
    expect(denied.body.detail).toContain('review.decide');

    await resolveOp(opsManager.token, tenantId, open.id, { decision: 'discard' }, ulid()).expect(200);

    // The upload's role floor: a reporter demoted to accountant cannot
    // operate the device's upload (the fresh per-command DB read).
    await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/users/${operator.userId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ role: 'accountant' })
      .expect(200);
    const demoted = await uploadReport(tenantId, badgeSession, [transferOpRow()], ulid()).expect(403);
    expect(demoted.body).toMatchObject({ code: 'role-denied' });
    expect(demoted.body.detail).toContain('accountant');
  });

  test('a foreign tenant cannot see (or resolve) another tenant\'s queue row — the row lookup is tenant-scoped', async () => {
    const { tenantId: tenantA, ownerToken: ownerA, badgeSession: badgeA } = await setupReportingTenant();
    const row = transferOpRow();
    await uploadReport(tenantA, badgeA, [row], ulid()).expect(201);
    const { items } = (await listRejectedOps(ownerA, tenantA).expect(200)).body;
    const open = items[0];

    const emailB = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId: tenantB } = await registerTenant(emailB);
    const tokenB = await signIn(emailB);
    // Tenant-b's session on its OWN path, asked to resolve tenant-a's row id:
    // the locked read is tenant-scoped — a clean 404.
    const foreign = await resolveOp(tokenB, tenantB, open.id, { decision: 'discard' }).expect(404);
    expect(foreign.body).toMatchObject({ code: 'not-found' });

    // The row is untouched and still open for its owner.
    const still = (await listRejectedOps(ownerA, tenantA, { status: 'open' }).expect(200)).body;
    expect(still.items).toHaveLength(1);
  });

  test('RLS: a non-superuser session reads another tenant\'s rejected ops as empty', async () => {
    const emailA = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId: tenantA } = await registerTenant(emailA);
    const tokenA = await signIn(emailA);
    const opsA = await createMember(tokenA, tenantA, 'operator');
    const deviceA = await enrollDevice(tokenA, tenantA, 'RLS scanner');
    const badgeA = await badgeInOperator(tenantA, deviceA.deviceToken, opsA.email);
    await uploadReport(tenantA, badgeA, [transferOpRow()], ulid()).expect(201);

    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    let scoped: postgres.Sql<Record<string, unknown>> | undefined;
    try {
      await admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(742107)`;
        await tx.unsafe(`
          do $$ begin
            if not exists (select from pg_roles where rolname = 'wms_rejected_ops_rls_probe') then
              create role wms_rejected_ops_rls_probe login password 'wms_rejected_ops_rls_probe' nosuperuser;
            end if;
          end $$;
        `);
        await tx.unsafe('grant usage on schema public to wms_rejected_ops_rls_probe');
        await tx.unsafe(
          'grant select, insert, update, delete on all tables in schema public to wms_rejected_ops_rls_probe',
        );
      });
      const probeUrl = new URL(process.env.DATABASE_URL!);
      probeUrl.username = 'wms_rejected_ops_rls_probe';
      probeUrl.password = 'wms_rejected_ops_rls_probe';
      scoped = postgres(probeUrl.toString(), { max: 1 });
      // Unscoped reads fail closed on the rejected_ops table.
      const unscoped = await scoped`select id from rejected_ops where tenant_id = ${tenantA}`;
      expect(unscoped).toHaveLength(0);
    } finally {
      await scoped?.end();
      // The probe role leaks nothing past its own test (the review's Entry I):
      // its grants are revoked and the login role itself dropped — a
      // blanket-granted credential must not outlive its assertion.
      try {
        await admin.unsafe('revoke select, insert, update, delete on all tables in schema public from wms_rejected_ops_rls_probe');
        await admin.unsafe('revoke usage on schema public from wms_rejected_ops_rls_probe');
        await admin.unsafe('drop role if exists wms_rejected_ops_rls_probe');
      } catch {
        // best-effort cleanup — the probe assertions already ran
      }
      await admin.end();
    }
  });

  test('the OpenAPI document exposes the sync-report + rejected-ops contract (drift guard companion)', async () => {
    const committed = JSON.parse(
      readFileSync(resolve(process.cwd(), 'openapi/openapi.json'), 'utf8') as string,
    ) as { paths: Record<string, unknown> };
    expect(Object.keys(committed.paths)).toEqual(
      expect.arrayContaining([
        '/tenants/{tenantId}/devices/sync-reports',
        '/tenants/{tenantId}/rejected-ops',
        '/tenants/{tenantId}/rejected-ops/{rejectedOpId}/resolve',
      ]),
    );
  });
});
