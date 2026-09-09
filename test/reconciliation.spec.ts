import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { sql as drizzleSql } from 'drizzle-orm';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { Database } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { reconcileScanInTx } from '../src/modules/inventory/ledger.service';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { PostgresOutboxRelay } from '../src/shared/events/outbox';
import type { DomainEvent, EventBus } from '../src/shared/events/event-bus.seam';
import {
  RECONCILIATION_CHECKPOINT_INVALID_EVENT,
  RECONCILIATION_DIVERGENCE_EVENT,
} from '../src/modules/inventory/reconcile';
import { ReconciliationWorker, parseReconcilePollMs } from '../src/jobs/jobs.module';

// The e2e suite talks to the real Postgres (docker-compose dev DB by
// default; CI provides the service container) and signs sessions.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
// A host that exports either poll interval would boot a background worker and
// race these tests — the suite drives `reconcile` / `reconcileNext` directly
// (the same convention as the outbox suite's relay).
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const INVITEE_PASSWORD = 'ops-password-123';

/**
 * A recording fake EVENT_BUS — the alert's arrival through the bus is what
 * the story's acceptance criteria name (via the relay in tests).
 */
class RecordingEventBus implements EventBus {
  readonly events: DomainEvent[] = [];

  async publish(event: DomainEvent): Promise<void> {
    this.events.push(event);
  }

  subscribe(): void {
    // Recording fake: no subscribers.
  }
}

describe('continuous replay-reconciliation (e2e, story 2.2)', () => {
  let app: INestApplication;
  let facade: InventoryFacade;
  let db: Database;
  let authDb: Database;
  let sql: postgres.Sql;
  const createdTenantIds: string[] = [];

  // Seeded aggregate roots (one tenant; three warehouses — the main matrix
  // warehouse, the checkpoint-validation warehouse, and the anchor warehouse).
  let tenantId: string;
  let opsToken: string;
  let warehouseId: string;
  let binA: string;
  let binB: string;
  let otherWarehouseId: string;
  let otherBinId: string;
  let anchorWarehouseId: string;
  let anchorBinId: string;
  let skuId: string;

  beforeAll(async () => {
    // Same deployment-parity probes as the sibling suites (auth + RLS roles,
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
    db = app.get<unknown>(DATABASE) as Database;
    authDb = app.get<unknown>(AUTH_DATABASE) as Database;
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });

    // Tenant + owner + an ops_manager (holds stock.adjust).
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Recon Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    const ownerToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;
    const opsEmail = `ops-${ulid().toLowerCase()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email: opsEmail, role: 'ops_manager' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken, password: INVITEE_PASSWORD })
      .expect(200);
    opsToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email: opsEmail, password: INVITEE_PASSWORD })
        .expect(200)
    ).body.accessToken as string;

    // One SKU via catalog import (the only SKU-creation path).
    const csvHeader = 'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const csv = `${csvHeader}\nSKU-R,Cardamom,pcs,,1800,,,,,`;
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
    skuId = ((skus.body.items as { code: string; id: string }[]).find(
      (item) => item.code === 'SKU-R',
    ) as { id: string }).id;

    // Three warehouses, each with its zone + bin(s).
    warehouseId = await createWarehouse(ownerToken, 'MAIN', ['A-01-01', 'A-01-02']);
    const mainBins = await binIds(warehouseId);
    binA = mainBins[0] as string;
    binB = mainBins[1] as string;
    otherWarehouseId = await createWarehouse(ownerToken, 'OTHER', ['B-01-01']);
    otherBinId = (await binIds(otherWarehouseId))[0] as string;
    anchorWarehouseId = await createWarehouse(ownerToken, 'ANCHOR', ['C-01-01']);
    anchorBinId = (await binIds(anchorWarehouseId))[0] as string;
  });

  afterAll(async () => {
    await cleanupRows();
    await sql.end();
    await (db as unknown as { $client?: { end(): Promise<void> } }).$client?.end();
    await (authDb as unknown as { $client?: { end(): Promise<void> } }).$client?.end();
    await app.close();
  });

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const cleaner = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      // The two NEW story-2.2 tables first (tenant-scoped data; the wms
      // owner bypasses RLS on its own tables — no replication role needed).
      await cleaner.unsafe(
        'DELETE FROM reconciliation_checkpoints WHERE tenant_id = ANY($1::uuid[])',
        [createdTenantIds],
      );
      await cleaner.unsafe('DELETE FROM inventory_quarantines WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      // The ledger tables are append-only by trigger — the suite's own
      // cleanup takes the superuser's replication-role bypass.
      await cleaner.unsafe('set session_replication_role = replica');
      await cleaner.unsafe('DELETE FROM ledger_events WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('DELETE FROM ledger_anchors WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('set session_replication_role = DEFAULT');
      await cleaner.unsafe('DELETE FROM stock_on_hand WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      // This suite's committed outbox rows (the relay worker is env-gated
      // OFF — nothing drains them here except the explicit bus-observation
      // test, which restores the foreign rows it had to drain past).
      await cleaner.unsafe('DELETE FROM outbox_messages WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('DELETE FROM catalog_import_errors WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('DELETE FROM catalog_imports WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('DELETE FROM uom_conversions WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('DELETE FROM skus WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM bins WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM zones WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM warehouses WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM tenants WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
    } finally {
      await cleaner.end();
    }
  }

  async function createWarehouse(ownerToken: string, code: string, binCodes: string[]): Promise<string> {
    const warehouse = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: `${code}-${ulid().slice(10, 16).toUpperCase()}`, name: `Recon ${code}` })
      .expect(201);
    const warehouseId = warehouse.body.id as string;
    const zone = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'A', name: `Zone ${code}` })
      .expect(201);
    const zoneId = zone.body.id as string;
    for (const binCode of binCodes) {
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 100, type: 'shelf', code: binCode })
        .expect(201);
    }
    return warehouseId;
  }

  async function binIds(targetWarehouseId: string): Promise<string[]> {
    const rows = await sql`
      select b.id from bins b
      join zones z on z.id = b.zone_id
      where z.warehouse_id = ${targetWarehouseId} order by b.code
    `;
    return rows.map((row) => row.id as string);
  }

  function adjust(binId: string, quantityDelta: number, warehouse = warehouseId): Promise<number> {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: warehouse, skuId, binId, quantityDelta, reasonCode: 'cycle-count', note: 'recon spec' })
      .expect(201)
      .then((res) => res.body.event.seq as number);
  }

  async function onHandFor(binId: string, warehouse = warehouseId): Promise<number | null> {
    const rows = await sql`
      select quantity from stock_on_hand
      where tenant_id = ${tenantId} and warehouse_id = ${warehouse} and bin_id = ${binId}
    `;
    return rows.length === 0 ? null : Number(rows[0]!.quantity);
  }

  /** The deliberate projection tamper (no trigger guards stock_on_hand). */
  async function tamperProjection(binId: string, delta: number, warehouse = warehouseId): Promise<void> {
    await sql`
      update stock_on_hand set quantity = quantity + ${delta}
      where tenant_id = ${tenantId} and warehouse_id = ${warehouse} and bin_id = ${binId}
    `;
  }

  async function projectionRows(warehouse = warehouseId): Promise<
    { bin_id: string; quantity: number; updated_at: Date }[]
  > {
    return (await sql`
      select bin_id, quantity, updated_at from stock_on_hand
      where tenant_id = ${tenantId} and warehouse_id = ${warehouse}
      order by bin_id
    `) as unknown as { bin_id: string; quantity: number; updated_at: Date }[];
  }

  async function checkpointRow(targetWarehouseId: string): Promise<
    | {
        last_seq: number;
        invalid_attempts: number;
        last_divergences: { skuId: string; binId: string }[] | null;
      }
    | undefined
  > {
    const rows = await sql`
      select last_seq, invalid_attempts, last_divergences from reconciliation_checkpoints
      where tenant_id = ${tenantId} and warehouse_id = ${targetWarehouseId} limit 1
    `;
    return rows[0] as
      | { last_seq: number; invalid_attempts: number; last_divergences: { skuId: string; binId: string }[] | null }
      | undefined;
  }

  async function quarantineRows(targetWarehouseId: string): Promise<
    { sku_id: string; bin_id: string; from_seq: number; to_seq: number; reason: string; status: string }[]
  > {
    return (await sql`
      select sku_id, bin_id, from_seq, to_seq, reason, status from inventory_quarantines
      where tenant_id = ${tenantId} and warehouse_id = ${targetWarehouseId} order by created_at
    `) as { sku_id: string; bin_id: string; from_seq: number; to_seq: number; reason: string; status: string }[];
  }

  async function outboxRows(type: string, warehouse = warehouseId): Promise<
    { id: string; payload: Record<string, unknown> }[]
  > {
    return (await sql`
      select id, payload from outbox_messages
      where tenant_id = ${tenantId} and type = ${type}
        and payload->>'warehouseId' = ${warehouse}
      order by created_at
    `) as { id: string; payload: Record<string, unknown> }[];
  }

  /**
   * A real relay cycle restricted to THIS suite's tenant: the discovery read
   * (the relay's one cross-tenant query, normally on the BYPASSRLS
   * connection) is stubbed to return only this tenant, so the drain delivers
   * my rows through the bus and acks nothing belonging to a concurrent
   * suite's tenant (jest workers share one database — a global drain would
   * steal another suite's seeded rows between their seed and their own
   * drain). Everything else — advisory lock, per-tenant batch, publish,
   * delete-on-ack — is the real relay path.
   *
   * Concurrent jest workers share the database, so a single drain is racy
   * twice over: the drain SHEDS (returns []) when another suite's relay holds
   * the `wms:outbox-relay` session advisory lock, and the row can vanish
   * entirely when that relay consumes it first. The helper therefore drains
   * on a bounded deadline until the expected event is observed; when the
   * pending row is gone without having been observed, it re-triggers the
   * divergence ONCE (`retrigger` — re-tamper + re-reconcile) to mint a fresh
   * row nobody has seen, and drains again before failing.
   */
  async function drainUntilObserved(
    bus: RecordingEventBus,
    type: string,
    retrigger: () => Promise<void> = async () => undefined,
  ): Promise<DomainEvent> {
    const scopedDiscovery = {
      execute: async () => [{ tenant_id: tenantId }],
    } as unknown as Database;
    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = Date.now() + 10_000;
    let retriggered = false;
    for (;;) {
      await new PostgresOutboxRelay(db, scopedDiscovery, bus).drain(1_000);
      const observed = bus.events.find(
        (event) => event.type === type && event.tenantId === tenantId,
      );
      if (observed !== undefined) {
        return observed;
      }
      if (Date.now() > deadline) {
        throw new Error(`outbox drain never delivered ${type} for this suite's tenant`);
      }
      if (!retriggered && (await outboxRows(type)).length === 0) {
        retriggered = true;
        await retrigger();
      }
      await delay(25);
    }
  }

  it('healthy cycle: the checkpoint advances to the watermark with no alert and zero projection writes', async () => {
    const seq1 = await adjust(binA, 5);
    const seq2 = await adjust(binA, 3);
    expect([seq1, seq2]).toEqual([1, 2]);

    const before = await projectionRows();
    const report = await facade.reconcile(tenantId, warehouseId);
    expect(report).toMatchObject({
      tenantId,
      warehouseId,
      watermark: 2,
      previousSeq: null,
      advanced: true,
      skipped: false,
      checkpointDiscarded: false,
    });
    expect(report.divergences).toEqual([]);
    expect(report.repaired).toEqual([]);
    expect(report.quarantined).toEqual([]);

    // Exactly one checkpoint row, at the window head, with a clean streak.
    const checkpoint = await checkpointRow(warehouseId);
    expect(checkpoint).toMatchObject({ last_seq: 2, invalid_attempts: 0, last_divergences: null });

    // Zero projection writes: the derived rows are byte-identical.
    expect(await projectionRows()).toEqual(before);

    // No alert of either story-2.2 type was emitted.
    expect(await outboxRows(RECONCILIATION_DIVERGENCE_EVENT)).toHaveLength(0);
    expect(await outboxRows(RECONCILIATION_CHECKPOINT_INVALID_EVENT)).toHaveLength(0);
  });

  it('incremental advance: the next cycle reconciles only the movement past the last checkpoint', async () => {
    const seq3 = await adjust(binB, 4);
    expect(seq3).toBe(3);

    const report = await facade.reconcile(tenantId, warehouseId);
    expect(report).toMatchObject({ previousSeq: 2, watermark: 3, advanced: true });
    expect(await checkpointRow(warehouseId)).toMatchObject({ last_seq: 3 });
    expect(await onHandFor(binA)).toBe(8);
    expect(await onHandFor(binB)).toBe(4);
  });

  it('tampered projection: detected in-window, rebuilt to the replayed quantity, and one divergence alert published through the bus', async () => {
    // A movement AFTER the last checkpoint puts the scope inside the next
    // window (seq 4) — then the deliberate tamper.
    const seq4 = await adjust(binA, 1); // binA replay: 9
    expect(seq4).toBe(4);
    await tamperProjection(binA, 7); // stored: 16

    const report = await facade.reconcile(tenantId, warehouseId);
    expect(report.advanced).toBe(false);
    expect(report.divergences).toHaveLength(1);
    expect(report.divergences[0]).toEqual({
      skuId,
      binId: binA,
      projectedQuantity: 16,
      replayedQuantity: 9,
      fromSeq: 4,
      toSeq: 4,
      repeat: false,
    });
    // The rebuild: the projection carries the REPLAYED quantity now.
    expect(report.repaired).toEqual([
      { skuId, binId: binA, projectedQuantity: 16, quantity: 9, deleted: false },
    ]);
    expect(await onHandFor(binA)).toBe(9);

    // One alert, committed together with the rebuild; the window did NOT
    // advance — the checkpoint remembers the flagged scope instead.
    const alertRows = await outboxRows(RECONCILIATION_DIVERGENCE_EVENT);
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0]!.payload).toEqual({
      warehouseId,
      watermark: 4,
      divergences: [
        { skuId, binId: binA, projected: 16, replayed: 9, fromSeq: 4, toSeq: 4, repeat: false },
      ],
    });
    expect(await checkpointRow(warehouseId)).toMatchObject({
      last_seq: 3,
      last_divergences: [{ skuId, binId: binA }],
    });
    expect(await quarantineRows(warehouseId)).toHaveLength(0);

    // Through the relay, the bus observes the divergence alert (my tenant's
    // rows only — foreign pending rows the drain had to pass are restored).
    // Concurrent suites can shed the drain or consume the row first — the
    // helper retries, and re-triggers the divergence once if the row is gone
    // (the re-flagged scope is quarantined and re-alerted; the assertions
    // below tolerate both the original and the re-triggered alert).
    const bus = new RecordingEventBus();
    const observed = await drainUntilObserved(bus, RECONCILIATION_DIVERGENCE_EVENT, async () => {
      await tamperProjection(binA, 1); // stored: 10 (replay: 9)
      const again = await facade.reconcile(tenantId, warehouseId);
      expect(again.divergences[0]!.repeat).toBe(true);
    });
    expect(observed.tenantId).toBe(tenantId);
    const observedPayload = observed.payload as {
      warehouseId: string;
      watermark: number;
      divergences: { skuId: string; binId: string; projected: number; replayed: number; fromSeq: number; toSeq: number; repeat: boolean }[];
    };
    expect(observedPayload).toMatchObject({ warehouseId, watermark: 4 });
    expect(observedPayload.divergences).toHaveLength(1);
    // `projected` and `repeat` differ between the original tamper (16, false)
    // and the re-triggered one (10, true) — everything else is pinned.
    expect(observedPayload.divergences[0]).toMatchObject({
      skuId,
      binId: binA,
      replayed: 9,
      fromSeq: 4,
      toSeq: 4,
    });
  });

  it('repeated divergence: the scope is quarantined and the repeat re-alerted; the open-quarantine backstop collapses duplicates', async () => {
    // The scope is flagged on the checkpoint (previous test) — tampering it
    // again makes the next cycle a REPEAT: quarantine + re-alert + rebuild.
    // (If the previous test's drain had to re-trigger the divergence, the
    // scope was quarantined and re-alerted one cycle earlier — every count
    // and quarantine assertion here is relative to that possibility.)
    const preQuarantines = await quarantineRows(warehouseId);
    const beforeRepeat = (await outboxRows(RECONCILIATION_DIVERGENCE_EVENT)).length;
    await tamperProjection(binA, 3); // stored: 12
    const report = await facade.reconcile(tenantId, warehouseId);
    expect(report.divergences[0]!.repeat).toBe(true);
    expect(report.quarantined).toEqual(
      preQuarantines.length === 0 ? [{ skuId, binId: binA }] : [],
    );
    expect(report.repaired).toEqual([
      { skuId, binId: binA, projectedQuantity: 12, quantity: 9, deleted: false },
    ]);
    // (The earlier alert rows were drained and acked by the bus-observation
    // step — counts here are relative to what is still pending.)
    const afterRepeat = await outboxRows(RECONCILIATION_DIVERGENCE_EVENT);
    expect(afterRepeat).toHaveLength(beforeRepeat + 1);
    expect(afterRepeat[afterRepeat.length - 1]!.payload['divergences']).toEqual([
      { skuId, binId: binA, projected: 12, replayed: 9, fromSeq: 4, toSeq: 4, repeat: true },
    ]);

    // A durable, open quarantine row naming the scope and its event range.
    const quarantines = await quarantineRows(warehouseId);
    expect(quarantines).toHaveLength(1);
    expect(quarantines[0]).toEqual({
      sku_id: skuId,
      bin_id: binA,
      from_seq: 4,
      to_seq: 4,
      reason: 'repeated-divergence',
      status: 'open',
    });

    // A third offense: re-alerted and rebuilt again, but the partial unique
    // index collapses the duplicate — still exactly one OPEN quarantine.
    await tamperProjection(binA, 2); // stored: 11
    const beforeThird = (await outboxRows(RECONCILIATION_DIVERGENCE_EVENT)).length;
    const third = await facade.reconcile(tenantId, warehouseId);
    expect(third.divergences[0]!.repeat).toBe(true);
    expect(third.quarantined).toEqual([]);
    const afterThird = await outboxRows(RECONCILIATION_DIVERGENCE_EVENT);
    expect(afterThird).toHaveLength(beforeThird + 1);
    expect(afterThird[afterThird.length - 1]!.payload['divergences']).toEqual([
      { skuId, binId: binA, projected: 11, replayed: 9, fromSeq: 4, toSeq: 4, repeat: true },
    ]);
    expect(await quarantineRows(warehouseId)).toHaveLength(1);
    expect(await onHandFor(binA)).toBe(9);
  });

  it('checkpoint invalid ×2: the first failure skips the pass, the second discards the checkpoint, replays fully, and alerts', async () => {
    // A clean full pass establishes the checkpoint on the other warehouse.
    const seq1 = await adjust(otherBinId, 2, otherWarehouseId);
    expect(seq1).toBe(1);
    const clean = await facade.reconcile(tenantId, otherWarehouseId);
    expect(clean).toMatchObject({ advanced: true, previousSeq: null, watermark: 1 });
    expect(await checkpointRow(otherWarehouseId)).toMatchObject({ last_seq: 1 });

    // Corrupt the checkpoint: last_seq beyond the ledger head.
    await sql`
      update reconciliation_checkpoints set last_seq = 100, invalid_attempts = 0
      where tenant_id = ${tenantId} and warehouse_id = ${otherWarehouseId}
    `;

    // First cycle: the validation failure is recorded and the pass SKIPPED —
    // never silently repaired, and no alert yet.
    const first = await facade.reconcile(tenantId, otherWarehouseId);
    expect(first).toMatchObject({
      advanced: false,
      skipped: true,
      checkpointDiscarded: false,
      watermark: 1,
      previousSeq: 100,
    });
    expect(await checkpointRow(otherWarehouseId)).toMatchObject({
      last_seq: 100,
      invalid_attempts: 1,
    });
    expect(await outboxRows(RECONCILIATION_CHECKPOINT_INVALID_EVENT, otherWarehouseId)).toHaveLength(0);

    // Second consecutive failure: discard, full replay from seq 1, alert.
    const second = await facade.reconcile(tenantId, otherWarehouseId);
    expect(second).toMatchObject({
      advanced: true, // the full replay verified the projections
      skipped: false,
      checkpointDiscarded: true,
      watermark: 1,
    });
    expect(second.divergences).toEqual([]);
    const alerts = await outboxRows(RECONCILIATION_CHECKPOINT_INVALID_EVENT, otherWarehouseId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload).toMatchObject({
      warehouseId: otherWarehouseId,
      lastSeq: 100,
      watermark: 1,
    });
    // The corrupt checkpoint is discarded, and the DISCARDING cycle's clean
    // full pass re-earns it to the watermark (so `advanced: true` is
    // truthful and the next cycle is bounded again).
    expect(await checkpointRow(otherWarehouseId)).toMatchObject({
      last_seq: 1,
      invalid_attempts: 0,
      last_divergences: null,
    });

    // The next cycle is bounded again — a clean window advance.
    const third = await facade.reconcile(tenantId, otherWarehouseId);
    expect(third).toMatchObject({ advanced: true, previousSeq: 1, watermark: 1 });
    expect(await checkpointRow(otherWarehouseId)).toMatchObject({
      last_seq: 1,
      invalid_attempts: 0,
      last_divergences: null,
    });
  });

  it('a movement committing beyond the watermark is not folded and not flagged — the next cycle reconciles it', async () => {
    // Event 5 commits "mid-cycle": the scan's watermark is still 4.
    const seq5 = await adjust(binB, 1); // binB replay: 5
    expect(seq5).toBe(5);
    await tamperProjection(binB, 6); // stored: 11

    // The bounded scan at watermark 4 — the window is (4,4]: the seq-5
    // movement is invisible (beyond the watermark) and its scope is neither
    // folded nor compared. No false positive.
    const stale = await withTenantTransaction(db, tenantId, (tx) =>
      reconcileScanInTx(tx, tenantId, warehouseId, 4, 4),
    );
    expect(stale.matches).toBe(true);
    expect(stale.divergences).toEqual([]);

    // The next cycle's window (3,5] includes the movement's scope: the
    // tamper is detected, rebuilt, and alerted — the next cycle's problem,
    // reconciled.
    const report = await facade.reconcile(tenantId, warehouseId);
    expect(report.divergences).toEqual([
      { skuId, binId: binB, projectedQuantity: 11, replayedQuantity: 5, fromSeq: 5, toSeq: 5, repeat: false },
    ]);
    expect(report.repaired).toEqual([
      { skuId, binId: binB, projectedQuantity: 11, quantity: 5, deleted: false },
    ]);
    expect(await onHandFor(binB)).toBe(5);
    expect(await checkpointRow(warehouseId)).toMatchObject({ last_seq: 3 });
  });

  it('an untouched divergent scope beyond the watermark is not flagged by a bounded scan — a movement over it is', async () => {
    // The window (3,5] is still unverified; a clean pass advances it to 5.
    const advance = await facade.reconcile(tenantId, warehouseId);
    expect(advance).toMatchObject({ advanced: true, previousSeq: 3, watermark: 5 });
    expect(await checkpointRow(warehouseId)).toMatchObject({ last_seq: 5, last_divergences: null });

    // Tamper a scope whose last event (seq 4) is at or below the checkpoint:
    // the window (5,5] is empty — the divergence is NOT flagged.
    await tamperProjection(binA, 4); // stored: 13
    const blind = await facade.reconcile(tenantId, warehouseId);
    expect(blind).toMatchObject({ advanced: true, divergences: [] });

    // A movement over the scope puts it inside the next window (5,6] —
    // detected, rebuilt to the replayed quantity.
    const seq6 = await adjust(binA, 1); // binA replay: 10
    expect(seq6).toBe(6);
    const caught = await facade.reconcile(tenantId, warehouseId);
    expect(caught.divergences).toEqual([
      { skuId, binId: binA, projectedQuantity: 14, replayedQuantity: 10, fromSeq: 6, toSeq: 6, repeat: false },
    ]);
    expect(caught.repaired).toEqual([
      { skuId, binId: binA, projectedQuantity: 14, quantity: 10, deleted: false },
    ]);
    expect(await onHandFor(binA)).toBe(10);
  });

  it('an event-less projection row is fabricated state — the repair deletes it and alerts the event-less range', async () => {
    // A full pass compares EVERY stored projection row against the replay —
    // delete the checkpoint to force one (a bounded scan only ever looks at
    // scopes touched by window events, so this branch is unreachable there).
    await sql`
      delete from reconciliation_checkpoints
      where tenant_id = ${tenantId} and warehouse_id = ${warehouseId}
    `;
    const fabricatedSkuId = uuidv7();
    const fabricatedBinId = uuidv7();
    // The deliberate fabrication: a stock row for a (sku, bin) scope with no
    // ledger events at all (plain SQL — stock_on_hand has no trigger).
    await sql`
      insert into stock_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, quantity)
      values (gen_random_uuid(), ${tenantId}, ${warehouseId}, ${fabricatedSkuId}, ${fabricatedBinId}, 5)
    `;
    expect(await onHandFor(fabricatedBinId)).toBe(5);

    const before = (await outboxRows(RECONCILIATION_DIVERGENCE_EVENT)).length;
    const report = await facade.reconcile(tenantId, warehouseId);
    expect(report.advanced).toBe(false);
    expect(report.divergences).toEqual([
      { skuId: fabricatedSkuId, binId: fabricatedBinId, projectedQuantity: 5, replayedQuantity: 0, repeat: false },
    ]);
    // The repair DELETES the fabricated row (the ledger is the only stock
    // truth — an event-less scope has nothing to rebuild toward).
    expect(report.repaired).toEqual([
      { skuId: fabricatedSkuId, binId: fabricatedBinId, projectedQuantity: 5, quantity: 0, deleted: true },
    ]);
    expect(await onHandFor(fabricatedBinId)).toBe(null);
    // The event-backed scopes were verified by the same full pass — untouched.
    expect(await onHandFor(binA)).toBe(10);
    expect(await onHandFor(binB)).toBe(5);

    // The alert names the fabricated scope with an event-less range
    // (fromSeq 1 .. watermark), committed with the repair. (Counts are
    // relative: earlier tests may leave their own undrained alert rows.)
    const alerts = await outboxRows(RECONCILIATION_DIVERGENCE_EVENT);
    expect(alerts).toHaveLength(before + 1);
    expect(alerts[alerts.length - 1]!.payload).toEqual({
      warehouseId,
      watermark: 6,
      divergences: [
        { skuId: fabricatedSkuId, binId: fabricatedBinId, projected: 5, replayed: 0, fromSeq: 1, toSeq: 6, repeat: false },
      ],
    });
    // The window did not advance — the fabricated scope is the checkpoint's
    // divergence memory now.
    expect(await checkpointRow(warehouseId)).toMatchObject({
      last_seq: 0,
      last_divergences: [{ skuId: fabricatedSkuId, binId: fabricatedBinId }],
    });
  });

  it('manual rebuild: the scoped and full repairs rewrite exactly the divergent scopes and alert with trigger manual-rebuild; a clean scope is a no-op', async () => {
    // Two movements (seq 7, seq 8) put both bins inside the (unverified)
    // window — then a tamper on each.
    const seq7 = await adjust(binA, 1); // binA replay: 11
    const seq8 = await adjust(binB, 1); // binB replay: 6
    expect([seq7, seq8]).toEqual([7, 8]);
    await tamperProjection(binA, 5); // stored: 16
    await tamperProjection(binB, 2); // stored: 8

    // The SCOPED repair: only the requested scope is proven divergent
    // (replay proves it — never a blind rewrite) and rewritten.
    const beforeScoped = (await outboxRows(RECONCILIATION_DIVERGENCE_EVENT)).length;
    const scoped = await facade.rebuildProjections(tenantId, warehouseId, { skuId, binId: binB });
    expect(scoped.divergences).toEqual([
      { skuId, binId: binB, projectedQuantity: 8, replayedQuantity: 6 },
    ]);
    expect(scoped.repaired).toEqual([
      { skuId, binId: binB, projectedQuantity: 8, quantity: 6, deleted: false },
    ]);
    expect(await onHandFor(binB)).toBe(6);
    expect(await onHandFor(binA)).toBe(16); // the sibling tamper is untouched
    const scopedAlerts = await outboxRows(RECONCILIATION_DIVERGENCE_EVENT);
    expect(scopedAlerts).toHaveLength(beforeScoped + 1);
    expect(scopedAlerts[scopedAlerts.length - 1]!.payload).toEqual({
      warehouseId,
      watermark: 8,
      trigger: 'manual-rebuild',
      divergences: [{ skuId, binId: binB, projected: 8, replayed: 6, fromSeq: 1, toSeq: 8 }],
    });

    // The FULL repair: every still-divergent scope of the warehouse.
    const beforeFull = (await outboxRows(RECONCILIATION_DIVERGENCE_EVENT)).length;
    const full = await facade.rebuildProjections(tenantId, warehouseId);
    expect(full.divergences).toEqual([{ skuId, binId: binA, projectedQuantity: 16, replayedQuantity: 11 }]);
    expect(full.repaired).toEqual([
      { skuId, binId: binA, projectedQuantity: 16, quantity: 11, deleted: false },
    ]);
    expect(await onHandFor(binA)).toBe(11);
    const fullAlerts = await outboxRows(RECONCILIATION_DIVERGENCE_EVENT);
    expect(fullAlerts).toHaveLength(beforeFull + 1);
    expect(fullAlerts[fullAlerts.length - 1]!.payload).toEqual({
      warehouseId,
      watermark: 8,
      trigger: 'manual-rebuild',
      divergences: [{ skuId, binId: binA, projected: 16, replayed: 11, fromSeq: 1, toSeq: 8 }],
    });

    // The CLEAN scope: a proven-clean replay writes nothing and alerts
    // nothing (silence is the outcome for a scope that matches).
    const beforeClean = (await outboxRows(RECONCILIATION_DIVERGENCE_EVENT)).length;
    const clean = await facade.rebuildProjections(tenantId, warehouseId);
    expect(clean).toEqual({ warehouseId, repaired: [], divergences: [] });
    expect(await outboxRows(RECONCILIATION_DIVERGENCE_EVENT)).toHaveLength(beforeClean);
  });

  it('verify-before-anchor: a tampered ledger range refuses the anchor, commits nothing, and fires the severity-1 alert', async () => {
    const seq1 = await adjust(anchorBinId, 6, anchorWarehouseId);
    expect(seq1).toBe(1);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    // The deliberate tamper: the append-only trigger is a plain (not ALWAYS)
    // trigger, so the replication-role bypass edits the delta — the stored
    // event_hash no longer matches the recomputed one.
    await sql.unsafe('set session_replication_role = replica');
    await sql.unsafe(
      'update ledger_events set quantity_delta = quantity_delta + 1 where tenant_id = $1 and warehouse_id = $2 and seq = 1',
      [tenantId, anchorWarehouseId],
    );
    await sql.unsafe('set session_replication_role = DEFAULT');

    const result = await facade.anchorChain(tenantId, anchorWarehouseId);
    expect('reason' in result).toBe(true);
    if ('reason' in result) {
      expect(result.ok).toBe(false);
      expect(result.fromSeq).toBe(1);
      expect(result.reason).toContain('hash mismatch at seq 1');
    }
    // No anchor row was committed over the broken range.
    const anchors = await sql`
      select id from ledger_anchors where tenant_id = ${tenantId} and warehouse_id = ${anchorWarehouseId}
    `;
    expect(anchors).toHaveLength(0);

    // Severity-1: the error log names the scope and range, and the
    // `ledger.chain_broken` alert rides the outbox.
    const alertText = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(alertText).toContain('ledger chain break');
    expect(alertText).toContain(`tenant=${tenantId}`);
    expect(alertText).toContain(`warehouse=${anchorWarehouseId}`);
    expect(alertText).toContain('seq=1..1');
    const broken = await outboxRows('ledger.chain_broken', anchorWarehouseId);
    expect(broken).toHaveLength(1);
    expect(broken[0]!.payload).toEqual({
      warehouseId: anchorWarehouseId,
      fromSeq: 1,
      toSeq: 1,
      reason: expect.stringContaining('hash mismatch at seq 1'),
    });
    errorSpy.mockRestore();
  });

  it('multi-warehouse fairness: one partition per tick, oldest-checkpoint-first — no partition starves', async () => {
    // whOther (checkpointed through its head by the checkpoint test) gets
    // fresh pending work; whMain is still pending (its window never closed).
    // The tick picks ONE partition per call (foreign suites' partitions may
    // consume some ticks — reconciliation discovery is cross-tenant by
    // design); both of this suite's partitions are reached well within the
    // budget.
    const seq2 = await adjust(otherBinId, 1, otherWarehouseId);
    expect(seq2).toBe(2);
    const seen = new Set<string>();
    for (let tick = 0; tick < 40 && !(seen.has(warehouseId) && seen.has(otherWarehouseId)); tick += 1) {
      const report = await facade.reconcileNext().catch(() => null);
      if (report !== null && report.tenantId === tenantId) {
        seen.add(report.warehouseId);
      }
    }
    expect(seen.has(warehouseId)).toBe(true);
    expect(seen.has(otherWarehouseId)).toBe(true);

    // Oldest-checkpoint-first: the checkpoints are bumped in a known order
    // (whMain first → the OLDER `updated_at`), both partitions are left
    // pending, and the next tick that lands on this tenant must pick whMain.
    // The anchor warehouse is reconciled too (its tampered chain's first
    // pass rebuilds, the second is clean) so no partition of this tenant
    // sits in the never-checkpointed bucket ahead of them.
    await facade.reconcile(tenantId, warehouseId);
    await facade.reconcile(tenantId, anchorWarehouseId);
    await facade.reconcile(tenantId, anchorWarehouseId);
    await facade.reconcile(tenantId, otherWarehouseId);
    await adjust(binA, 1); // whMain head: 7 (checkpoint last_seq: 6)
    await adjust(otherBinId, 1, otherWarehouseId); // whOther head: 3 (last_seq: 2)
    let picked: string | undefined;
    for (let tick = 0; tick < 40 && picked === undefined; tick += 1) {
      const report = await facade.reconcileNext().catch(() => null);
      if (report !== null && report.tenantId === tenantId) {
        picked = report.warehouseId;
      }
    }
    expect(picked).toBe(warehouseId);
  });

  it('detection transactions pin repeatable read isolation (the consistent-snapshot read)', async () => {
    const level = await withTenantTransaction(
      db,
      tenantId,
      async (tx) => {
        const rows = (await tx.execute(
          drizzleSql`select current_setting('transaction_isolation') as level`,
        )) as unknown as { level: string }[];
        return rows[0]!.level;
      },
      { isolationLevel: 'repeatable read' },
    );
    expect(level).toBe('repeatable read');
  });

  it('the two new tables are tenant-isolated and fail closed', async () => {
    // A checkpoint and a quarantine exist from the earlier tests.
    expect(await checkpointRow(warehouseId)).toBeDefined();
    expect(await quarantineRows(warehouseId)).toHaveLength(1);

    const probeUrl = new URL(process.env.DATABASE_URL!);
    probeUrl.username = 'wms_rls_probe';
    probeUrl.password = 'wms_rls_probe';
    const probe = postgres(probeUrl.toString(), { max: 1 });
    const otherTenant = '11111111-1111-1111-1111-111111111111';
    try {
      for (const table of ['reconciliation_checkpoints', 'inventory_quarantines']) {
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

      // A scoped session cannot seed a row stamped with another tenant.
      const foreignCheckpoint = probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        await tx`
          insert into reconciliation_checkpoints (id, tenant_id, warehouse_id, last_seq)
          values (gen_random_uuid(), ${otherTenant}, ${otherWarehouseId}, 0)
        `;
      });
      await expect(foreignCheckpoint).rejects.toThrow(/row-level security/i);
      const foreignQuarantine = probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        await tx`
          insert into inventory_quarantines (id, tenant_id, warehouse_id, sku_id, bin_id, from_seq, to_seq, reason, status)
          values (gen_random_uuid(), ${otherTenant}, ${otherWarehouseId}, ${skuId}, ${binA}, 1, 1, 'repeated-divergence', 'open')
        `;
      });
      await expect(foreignQuarantine).rejects.toThrow(/row-level security/i);
    } finally {
      await probe.end();
    }
  });
});

describe('reconciliation worker plumbing (unit, story 2.2)', () => {
  const ENV_KEY = 'OUTBOX_RECONCILE_POLL_MS';

  function setEnv(value: string | undefined): void {
    if (value === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = value;
    }
  }

  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) {
        throw new Error('waitFor: condition never became true');
      }
      await delay(5);
    }
  }

  afterEach(() => {
    setEnv(undefined);
  });

  describe('parseReconcilePollMs', () => {
    it('unset and empty are off (0)', () => {
      expect(parseReconcilePollMs(undefined)).toBe(0);
      expect(parseReconcilePollMs('')).toBe(0);
    });

    it('non-negative integers pass through (0 included)', () => {
      expect(parseReconcilePollMs('2000')).toBe(2000);
      expect(parseReconcilePollMs('0')).toBe(0);
    });

    it('anything not a non-negative integer fails the boot loudly', () => {
      expect(() => parseReconcilePollMs('soon')).toThrow(/OUTBOX_RECONCILE_POLL_MS/);
      expect(() => parseReconcilePollMs('1.5')).toThrow(/OUTBOX_RECONCILE_POLL_MS/);
      expect(() => parseReconcilePollMs('-5')).toThrow(/OUTBOX_RECONCILE_POLL_MS/);
    });
  });

  describe('ReconciliationWorker', () => {
    it('an invalid env fails the constructor (loud boot, not a silent worker)', () => {
      for (const bad of ['soon', '1.5', '-5']) {
        setEnv(bad);
        expect(() => new ReconciliationWorker(stubFacade() as never)).toThrow(
          /OUTBOX_RECONCILE_POLL_MS/,
        );
      }
    });

    it('pollMs=0 (env unset) schedules nothing', async () => {
      setEnv(undefined);
      const facade = stubFacade();
      const worker = new ReconciliationWorker(facade as never);
      worker.onApplicationBootstrap();
      await delay(60);
      expect(facade.calls).toHaveLength(0);
      worker.onApplicationShutdown();
    });

    it('bootstrap with a poll interval drives reconcileNext on the timer', async () => {
      setEnv('20');
      const facade = stubFacade();
      const worker = new ReconciliationWorker(facade as never);
      worker.onApplicationBootstrap();
      try {
        await waitFor(() => facade.calls.length >= 2);
      } finally {
        worker.onApplicationShutdown();
      }
    });

    it('an in-flight cycle sheds the next ticks until it settles', async () => {
      setEnv('15');
      const facade = stubFacade();
      facade.hold = true;
      const worker = new ReconciliationWorker(facade as never);
      worker.onApplicationBootstrap();
      try {
        await waitFor(() => facade.calls.length === 1);
        await delay(60);
        expect(facade.calls).toHaveLength(1);
        facade.release();
        await waitFor(() => facade.calls.length >= 2);
      } finally {
        facade.release();
        worker.onApplicationShutdown();
      }
    });

    it('a failing cycle is logged and the next tick still drives reconcileNext', async () => {
      setEnv('15');
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const calls: number[] = [];
      const failing = {
        async reconcileNext(): Promise<null> {
          calls.push(calls.length);
          throw new Error('boom');
        },
      };
      const worker = new ReconciliationWorker(failing as never);
      worker.onApplicationBootstrap();
      try {
        await waitFor(() => calls.length >= 1);
        // The failure surfaces loudly.
        expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
          'Reconciliation cycle failed: boom',
        );
        // The failure does not wedge the loop — the next tick drives again.
        await waitFor(() => calls.length >= 2);
      } finally {
        worker.onApplicationShutdown();
        errorSpy.mockRestore();
      }
    });

    it('shutdown clears the timer (no further cycles)', async () => {
      setEnv('15');
      const facade = stubFacade();
      const worker = new ReconciliationWorker(facade as never);
      worker.onApplicationBootstrap();
      await waitFor(() => facade.calls.length >= 1);
      worker.onApplicationShutdown();
      const atShutdown = facade.calls.length;
      await delay(80);
      expect(facade.calls.length).toBe(atShutdown);
    });

    /** A facade stub recording cycles, able to hold one in flight. */
    function stubFacade(): {
      calls: number[];
      hold: boolean;
      reconcileNext(): Promise<null>;
      release(): void;
    } {
      const calls: number[] = [];
      let held: (() => void) | undefined;
      return {
        calls,
        hold: false,
        async reconcileNext() {
          calls.push(calls.length);
          if (this.hold && held === undefined) {
            await new Promise<void>((resolve) => {
              held = resolve;
            });
          }
          return null;
        },
        release() {
          held?.();
          held = undefined;
        },
      };
    }
  });
});
