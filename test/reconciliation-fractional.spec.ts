import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid } from '../src/shared/primitives/ids';
// `fromMilli`/`toMilli` stay unimported on purpose: every milli/base-unit
// boundary in this suite is crossed by production code (`fromMilli` inside
// the alert mapping) or asserted as a raw milli literal against the stored
// column — the suite pins exact integers, not its own conversions.
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { RECONCILIATION_DIVERGENCE_EVENT } from '../src/modules/inventory/reconcile';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

// The e2e suite talks to the real Postgres (docker-compose dev DB by
// default; CI provides the service container) and signs sessions.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
// A host that exports either poll interval would boot a background worker and
// race these tests — the suite drives `reconcile` directly (the sibling
// suites' convention).
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
// Story 10.4's cadence, tightened so a full pass is REACHABLE in a test
// without seeding 20 bounded passes: N=2 means the pass kinds march
// full → bounded → bounded → full → … (the counter starts at 0 on the
// partition's first — full — cycle). Set BEFORE `createApp`: the service
// reads the knob in its constructor, so this must beat the boot.
process.env.RECONCILE_FULL_PASS_EVERY = '2';

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const INVITEE_PASSWORD = 'ops-password-123';

interface CheckpointRow {
  last_seq: number;
  invalid_attempts: number;
  incremental_count: number;
  updated_at: Date;
  last_divergences: { skuId: string; binId: string; batchRef?: string }[] | null;
}

interface QuarantineRow {
  sku_id: string;
  bin_id: string;
  from_seq: number;
  to_seq: number;
  reason: string;
  status: string;
}

/**
 * Story 10.4: fractional balances are reconciled EXACTLY — the reconcile
 * path's arithmetic is untouched, so a divergence of a few MILLI-units (the
 * corruption 10.4 actually defends against: a tamper that survives every
 * base-unit comparison) is detected, named honestly in base units, and
 * rebuilt; a batch-arm imbalance names its batch; and the bounded scan's
 * blind spot is closed by the scheduled full pass, driven by the
 * `incremental_count` counter.
 *
 * Every row gets its OWN warehouse: the pass-kind counter is per partition,
 * so co-locating rows would entangle their marches (the knob is '2' — a full
 * pass lands every third cycle — and each row's cycle count is deliberate).
 */
describe('reconciliation over fractional stock (e2e, story 10.4)', () => {
  let app: INestApplication;
  let facade: InventoryFacade;
  let sql: postgres.Sql;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let eachSkuId: string;
  let kgSkuId: string;
  let kgBatchSkuId: string;

  let suiteDb: SuiteDatabase;

  beforeAll(async () => {
    // infra-1: this suite owns its own database (cloned from the template —
    // migration 0029's `incremental_count` flows in with every other column).
    suiteDb = await useSuiteDatabase('reconfractional');
    Logger.overrideLogger(false);
    app = await createApp();
    await app.init();
    facade = app.get(InventoryFacade);
    sql = postgres(process.env.DATABASE_URL!, { max: 2 });

    // Tenant + owner + an ops_manager (holds stock.adjust).
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `ReconFrac Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;
    opsToken = await inviteAndSignIn('ops_manager', INVITEE_PASSWORD);

    // Three SKUs: an each-counted one (0-dp unit), a measured kg one (3-dp),
    // and a batch-tracked kg one — a batch-tracked SKU may measure in kg (the
    // measured-unit constraint is about SERIALS, not batches).
    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const csv = [
      csvHeader,
      'RCF-EACH,Each Widget,each,,1800,,false,false,,,',
      'RCF-KG,Measured Grain,kg,,1800,,false,false,,,',
      'RCF-KG-BT,Batched Grain,kg,,1800,,true,false,,,',
    ].join('\n');
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const catalog = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/skus`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    for (const item of catalog.body.items as { code: string; id: string }[]) {
      if (item.code === 'RCF-EACH') eachSkuId = item.id;
      if (item.code === 'RCF-KG') kgSkuId = item.id;
      if (item.code === 'RCF-KG-BT') kgBatchSkuId = item.id;
    }
    expect(eachSkuId).toBeDefined();
    expect(kgSkuId).toBeDefined();
    expect(kgBatchSkuId).toBeDefined();
  }, 60_000);

  afterAll(async () => {
    await cleanupRows();
    const rawDb = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await rawDb.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await sql.end();
    await app.close();
    await suiteDb.drop();
  });

  async function inviteAndSignIn(role: string, password: string): Promise<string> {
    const address = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email: address, role })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken, password })
      .expect(200);
    return (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email: address, password })
        .expect(200)
    ).body.accessToken as string;
  }

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const cleaner = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await cleaner.unsafe(
        'DELETE FROM reconciliation_checkpoints WHERE tenant_id = ANY($1::uuid[])',
        [createdTenantIds],
      );
      await cleaner.unsafe('DELETE FROM inventory_quarantines WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('set session_replication_role = replica');
      await cleaner.unsafe('DELETE FROM ledger_events WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('set session_replication_role = DEFAULT');
      await cleaner.unsafe('DELETE FROM batch_on_hand WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('DELETE FROM stock_on_hand WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('DELETE FROM batches WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
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

  async function createWarehouse(
    code: string,
    binCodes: string[],
  ): Promise<{ warehouseId: string; binIds: string[] }> {
    const warehouse = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: `${code}-${ulid().slice(10, 16).toUpperCase()}`, name: `ReconFrac ${code}` })
      .expect(201);
    const warehouseId = warehouse.body.id as string;
    const zone = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'A', name: `Zone ${code}` })
      .expect(201);
    const zoneId = zone.body.id as string;
    const binIds: string[] = [];
    for (const binCode of binCodes) {
      binIds.push(
        (
          await request(app.getHttpServer())
            .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .set(KEY_HEADER, ulid())
            .send({ capacity: 100, type: 'shelf', code: binCode })
            .expect(201)
        ).body.id as string,
      );
    }
    return { warehouseId, binIds };
  }

  function adjust(
    warehouseId: string,
    skuId: string,
    binId: string,
    quantityDelta: number,
    batch?: { code: string },
  ): Promise<number> {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        skuId,
        binId,
        quantityDelta,
        reasonCode: 'cycle-count',
        note: 'recon-fractional spec',
        ...(batch !== undefined ? { batch } : {}),
      })
      .expect(201)
      .then((res) => res.body.event.seq as number);
  }

  /** The stored stock column, in milli-units — what the domain actually holds. */
  async function stockMilli(skuId: string, binId: string, warehouseId: string): Promise<number> {
    const rows = await sql`
      select coalesce(sum(quantity), 0)::bigint as q from stock_on_hand
      where tenant_id = ${tenantId} and warehouse_id = ${warehouseId}
        and sku_id = ${skuId} and bin_id = ${binId}
    `;
    return Number((rows[0] as unknown as { q: string }).q);
  }

  /** The batch arm's stored quantity, in milli-units. */
  async function batchMilli(
    skuId: string,
    binId: string,
    batchId: string,
    warehouseId: string,
  ): Promise<number> {
    const rows = await sql`
      select coalesce(sum(quantity), 0)::bigint as q from batch_on_hand
      where tenant_id = ${tenantId} and warehouse_id = ${warehouseId}
        and sku_id = ${skuId} and bin_id = ${binId} and batch_id = ${batchId}
    `;
    return Number((rows[0] as unknown as { q: string }).q);
  }

  /**
   * The deliberate projection tamper, in raw MILLI-units (the point of this
   * suite: a tamper finer than any base-unit value, invisible to every
   * comparison that rounds — exact only because the fold and the compare run
   * on milli-unit integers).
   */
  async function tamperStockMilli(
    skuId: string,
    binId: string,
    warehouseId: string,
    deltaMilli: number,
  ): Promise<void> {
    await sql`
      update stock_on_hand set quantity = quantity + ${deltaMilli}
      where tenant_id = ${tenantId} and warehouse_id = ${warehouseId}
        and sku_id = ${skuId} and bin_id = ${binId}
    `;
  }

  async function tamperBatchMilli(
    skuId: string,
    binId: string,
    batchId: string,
    warehouseId: string,
    deltaMilli: number,
  ): Promise<void> {
    await sql`
      update batch_on_hand set quantity = quantity + ${deltaMilli}
      where tenant_id = ${tenantId} and warehouse_id = ${warehouseId}
        and sku_id = ${skuId} and bin_id = ${binId} and batch_id = ${batchId}
    `;
  }

  async function checkpointRow(targetWarehouseId: string): Promise<CheckpointRow | undefined> {
    const rows = await sql`
      select last_seq, invalid_attempts, incremental_count, updated_at, last_divergences
      from reconciliation_checkpoints
      where tenant_id = ${tenantId} and warehouse_id = ${targetWarehouseId} limit 1
    `;
    return rows[0] as CheckpointRow | undefined;
  }

  async function quarantineRows(targetWarehouseId: string): Promise<QuarantineRow[]> {
    return (await sql`
      select sku_id, bin_id, from_seq, to_seq, reason, status from inventory_quarantines
      where tenant_id = ${tenantId} and warehouse_id = ${targetWarehouseId} order by created_at
    `) as unknown as QuarantineRow[];
  }

  async function divergenceAlerts(targetWarehouseId: string): Promise<
    { payload: Record<string, unknown> }[]
  > {
    return (await sql`
      select payload from outbox_messages
      where tenant_id = ${tenantId} and type = ${RECONCILIATION_DIVERGENCE_EVENT}
        and payload->>'warehouseId' = ${targetWarehouseId}
      order by created_at
    `) as unknown as { payload: Record<string, unknown> }[];
  }

  it('a milli tamper on a measured (kg) SKU is detected and named exactly — projected 0.307 against replayed 0.3, rebuilt, and the next cycle is clean', async () => {
    const wh = await createWarehouse('KG1', ['A-01-01']);
    const bin = wh.binIds[0] as string;
    const seq1 = await adjust(wh.warehouseId, kgSkuId, bin, 0.1);
    expect(seq1).toBe(1);
    // The partition's first cycle is a FULL pass (no checkpoint) — a clean one
    // leaves the counter at 0.
    const first = await facade.reconcile(tenantId, wh.warehouseId);
    expect(first).toMatchObject({ advanced: true, previousSeq: null, watermark: 1 });
    expect(await checkpointRow(wh.warehouseId)).toMatchObject({
      last_seq: 1,
      incremental_count: 0,
      last_divergences: null,
    });

    // A movement after the checkpoint puts the scope inside the next window,
    // then the tamper: +7 MILLI-UNITS — 0.007 kg, invisible at any base-unit
    // granularity and exactly representable in milli-units.
    const seq2 = await adjust(wh.warehouseId, kgSkuId, bin, 0.2);
    expect(seq2).toBe(2);
    await tamperStockMilli(kgSkuId, bin, wh.warehouseId, 7); // stored: 307, replay: 300

    const report = await facade.reconcile(tenantId, wh.warehouseId);
    expect(report.advanced).toBe(false);
    expect(report.divergences).toHaveLength(1);
    // The detection is EXACT (milli-units inside the domain).
    expect(report.divergences[0]).toMatchObject({
      skuId: kgSkuId,
      binId: bin,
      projectedQuantity: 307,
      replayedQuantity: 300,
      fromSeq: 2,
      toSeq: 2,
      repeat: false,
    });
    // …and the alert names it in base units, honestly: 0.307 is the corrupted
    // projection as the operator would have weighed it — never rounded to the
    // nearest recordable value.
    const alerts = await divergenceAlerts(wh.warehouseId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload).toEqual({
      warehouseId: wh.warehouseId,
      watermark: 2,
      divergences: [
        {
          skuId: kgSkuId,
          binId: bin,
          projected: 0.307,
          replayed: 0.3,
          fromSeq: 2,
          toSeq: 2,
          repeat: false,
        },
      ],
    });
    // The rebuild carries the REPLAYED quantity: the milli tamper is gone.
    expect(await stockMilli(kgSkuId, bin, wh.warehouseId)).toBe(300);
    // The window did not advance, the scope is remembered — and the DIVERGENT
    // bounded pass still incremented the counter (the rule follows the pass
    // kind, not the outcome).
    expect(await checkpointRow(wh.warehouseId)).toMatchObject({
      last_seq: 1,
      incremental_count: 1,
      last_divergences: [{ skuId: kgSkuId, binId: bin }],
    });

    // The repaired scope's next movement closes its window cleanly — no
    // quarantine (one divergence is a repair, not a crime).
    const seq3 = await adjust(wh.warehouseId, kgSkuId, bin, 0.05);
    expect(seq3).toBe(3);
    const clean = await facade.reconcile(tenantId, wh.warehouseId);
    expect(clean).toMatchObject({ advanced: true, previousSeq: 1, watermark: 3 });
    expect(await checkpointRow(wh.warehouseId)).toMatchObject({
      last_seq: 3,
      incremental_count: 2,
      last_divergences: null,
    });
    expect(await quarantineRows(wh.warehouseId)).toHaveLength(0);
  });

  it('a milli tamper on an each-counted SKU renders the corrupted count honestly — projected 9.007 against replayed 9', async () => {
    const wh = await createWarehouse('EACH1', ['A-01-01']);
    const bin = wh.binIds[0] as string;
    const seq1 = await adjust(wh.warehouseId, eachSkuId, bin, 5);
    expect(seq1).toBe(1);
    const first = await facade.reconcile(tenantId, wh.warehouseId);
    expect(first).toMatchObject({ advanced: true, watermark: 1 });

    const seq2 = await adjust(wh.warehouseId, eachSkuId, bin, 4); // replay: 9
    expect(seq2).toBe(2);
    await tamperStockMilli(eachSkuId, bin, wh.warehouseId, 7); // stored: 9007

    const report = await facade.reconcile(tenantId, wh.warehouseId);
    expect(report.divergences).toHaveLength(1);
    expect(report.divergences[0]).toMatchObject({
      skuId: eachSkuId,
      binId: bin,
      projectedQuantity: 9007,
      replayedQuantity: 9000,
    });
    // An each-counted balance is rendered by `fromMilli` even when a tamper
    // has knocked it off the whole-unit lattice: 9007 milli reads 9.007, the
    // honest description of corrupt state — never a rounded 9 that would
    // hide the imbalance.
    const alerts = await divergenceAlerts(wh.warehouseId);
    expect(alerts).toHaveLength(1);
    expect((alerts[0]!.payload['divergences'] as Record<string, unknown>[])[0]).toEqual({
      skuId: eachSkuId,
      binId: bin,
      projected: 9.007,
      replayed: 9,
      fromSeq: 2,
      toSeq: 2,
      repeat: false,
    });
    expect(await stockMilli(eachSkuId, bin, wh.warehouseId)).toBe(9000);
  });

  it('a fractional batch-arm divergence names its batch in the alert and the checkpoint memory — and the repeat still quarantines the (sku, bin) scope', async () => {
    const wh = await createWarehouse('BT1', ['A-01-01']);
    const bin = wh.binIds[0] as string;
    // Intake 2.5 kg of batch B-1 (seq 1), then 0.5 kg more of the same batch
    // (seq 2) — the second movement is what puts the batch scope inside the
    // next bounded window.
    const seq1 = await adjust(wh.warehouseId, kgBatchSkuId, bin, 2.5, { code: 'B-1' });
    expect(seq1).toBe(1);
    const first = await facade.reconcile(tenantId, wh.warehouseId);
    expect(first).toMatchObject({ advanced: true, watermark: 1 });
    const batchId = await batchIdFor(kgBatchSkuId, 'B-1');
    expect(await batchMilli(kgBatchSkuId, bin, batchId, wh.warehouseId)).toBe(2500);

    const seq2 = await adjust(wh.warehouseId, kgBatchSkuId, bin, 0.5, { code: 'B-1' });
    expect(seq2).toBe(2);
    // The tamper lands on the BATCH arm only: 3 milli-units — 0.003 kg, three
    // thousandths of a batch. The (sku, bin) stock row stays exact; only the
    // batch projection lies.
    await tamperBatchMilli(kgBatchSkuId, bin, batchId, wh.warehouseId, 3); // batch: 3003

    const report = await facade.reconcile(tenantId, wh.warehouseId);
    expect(report.advanced).toBe(false);
    expect(report.divergences).toHaveLength(1);
    expect(report.divergences[0]).toMatchObject({
      skuId: kgBatchSkuId,
      binId: bin,
      batchRef: batchId,
      projectedQuantity: 3003,
      replayedQuantity: 3000,
      fromSeq: 2,
      toSeq: 2,
      repeat: false,
    });
    // The alert carries the batch identity (optional key, additive on the
    // 10.1 payload contract) — a (sku, bin, batch) imbalance is nameable
    // without a jsonb scan.
    const alerts = await divergenceAlerts(wh.warehouseId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload).toEqual({
      warehouseId: wh.warehouseId,
      watermark: 2,
      divergences: [
        {
          skuId: kgBatchSkuId,
          binId: bin,
          batchRef: batchId,
          projected: 3.003,
          replayed: 3,
          fromSeq: 2,
          toSeq: 2,
          repeat: false,
        },
      ],
    });
    // The rebuild fixes the batch arm to the replayed quantity.
    expect(await batchMilli(kgBatchSkuId, bin, batchId, wh.warehouseId)).toBe(3000);
    // The memory carries the batch identity too — the next cycle classifies
    // through it.
    expect(await checkpointRow(wh.warehouseId)).toMatchObject({
      last_seq: 1,
      last_divergences: [{ skuId: kgBatchSkuId, binId: bin, batchRef: batchId }],
    });

    // Second offense: the repeat classifies THROUGH the batchRef-bearing
    // memory (the key stays `skuId:binId`), re-alerts with `repeat: true` —
    // and the quarantine is keyed (sku, bin), NOT (sku, bin, batch): ATP
    // fail-closure lives at the granularity ATP is granted.
    await tamperBatchMilli(kgBatchSkuId, bin, batchId, wh.warehouseId, 1); // batch: 3001
    const repeatReport = await facade.reconcile(tenantId, wh.warehouseId);
    expect(repeatReport.divergences).toHaveLength(1);
    expect(repeatReport.divergences[0]).toMatchObject({
      skuId: kgBatchSkuId,
      binId: bin,
      batchRef: batchId,
      projectedQuantity: 3001,
      replayedQuantity: 3000,
      repeat: true,
    });
    const repeatAlerts = await divergenceAlerts(wh.warehouseId);
    expect(repeatAlerts).toHaveLength(2);
    expect((repeatAlerts[1]!.payload['divergences'] as Record<string, unknown>[])[0]).toEqual({
      skuId: kgBatchSkuId,
      binId: bin,
      batchRef: batchId,
      projected: 3.001,
      replayed: 3,
      fromSeq: 2,
      toSeq: 2,
      repeat: true,
    });
    expect(await quarantineRows(wh.warehouseId)).toEqual([
      {
        sku_id: kgBatchSkuId,
        bin_id: bin,
        from_seq: 2,
        to_seq: 2,
        reason: 'repeated-divergence',
        status: 'open',
      },
    ]);
  });

  it('mixed-precision warehouse: one bounded scan verifies both the each-counted and measured scopes in one window — and the scheduled full pass catches the blind-spot tamper the bounded scan cannot see', async () => {
    const wh = await createWarehouse('MIX', ['A-01-01', 'A-01-02']);
    const binE = wh.binIds[0] as string;
    const binK = wh.binIds[1] as string;
    const seq1 = await adjust(wh.warehouseId, eachSkuId, binE, 5);
    const seq2 = await adjust(wh.warehouseId, kgSkuId, binK, 0.25);
    expect([seq1, seq2]).toEqual([1, 2]);
    const first = await facade.reconcile(tenantId, wh.warehouseId);
    expect(first).toMatchObject({ advanced: true, watermark: 2 });
    expect(await checkpointRow(wh.warehouseId)).toMatchObject({ incremental_count: 0 });

    // Movements over BOTH precisions (seq 3 each-counted, seq 4 measured) put
    // both scopes inside the next bounded window (2, 4] — one scan verifies
    // both, exactly: 7000 and 1000 milli.
    const seq3 = await adjust(wh.warehouseId, eachSkuId, binE, 2);
    const seq4 = await adjust(wh.warehouseId, kgSkuId, binK, 0.75);
    expect([seq3, seq4]).toEqual([3, 4]);
    const bounded = await facade.reconcile(tenantId, wh.warehouseId);
    expect(bounded).toMatchObject({ advanced: true, previousSeq: 2, watermark: 4 });
    expect(await checkpointRow(wh.warehouseId)).toMatchObject({
      last_seq: 4,
      incremental_count: 1,
      last_divergences: null,
    });

    // The blind spot: tamper binK — its last event (seq 4) is AT the
    // checkpoint, so the next window (4, 4] is empty and the bounded scan
    // CANNOT see the divergence. The clean advance is exactly the trap the
    // scheduled full pass exists to close.
    await tamperStockMilli(kgSkuId, binK, wh.warehouseId, 7); // stored: 1007
    const blind = await facade.reconcile(tenantId, wh.warehouseId);
    expect(blind).toMatchObject({ advanced: true, divergences: [] });
    expect(await checkpointRow(wh.warehouseId)).toMatchObject({
      last_seq: 4,
      incremental_count: 2,
    });

    // The counter has accumulated 2 bounded passes ≥ the knob's cadence
    // (RECONCILE_FULL_PASS_EVERY=2): the next cycle is a FULL pass, and the
    // blind-spot divergence is caught — a bounded scan can never flag a scope
    // untouched since its checkpoint, so this detection itself proves the
    // full pass ran.
    const caught = await facade.reconcile(tenantId, wh.warehouseId);
    expect(caught.advanced).toBe(false);
    expect(caught.divergences).toHaveLength(1);
    // (The full replay's divergences carry no window range — that is the
    // bounded scan's own field; the alert maps them to `fromSeq 1 .. toSeq
    // watermark` on the way out.)
    expect(caught.divergences[0]).toMatchObject({
      skuId: kgSkuId,
      binId: binK,
      projectedQuantity: 1007,
      replayedQuantity: 1000,
      repeat: false,
    });
    expect(caught.divergences[0]!.fromSeq).toBeUndefined();
    expect(caught.divergences[0]!.toSeq).toBeUndefined();
    const caughtAlerts = await divergenceAlerts(wh.warehouseId);
    expect(caughtAlerts).toHaveLength(1);
    expect((caughtAlerts[0]!.payload['divergences'] as Record<string, unknown>[])[0]).toMatchObject({
      skuId: kgSkuId,
      binId: binK,
      projected: 1.007,
      replayed: 1,
      fromSeq: 1,
      toSeq: 4,
      repeat: false,
    });
    expect(await stockMilli(kgSkuId, binK, wh.warehouseId)).toBe(1000);
    // The each-counted sibling was verified by the same full pass — untouched.
    expect(await stockMilli(eachSkuId, binE, wh.warehouseId)).toBe(7000);
    // A full pass resets the counter even on the divergent arm.
    expect(await checkpointRow(wh.warehouseId)).toMatchObject({
      last_seq: 4,
      incremental_count: 0,
      last_divergences: [{ skuId: kgSkuId, binId: binK }],
    });
  });

  it('the pass-kind counter marches 0 → 1 → 2 → 0 as the partition alternates bounded and full passes', async () => {
    const wh = await createWarehouse('CNT', ['A-01-01']);
    const bin = wh.binIds[0] as string;

    // Cycle 1 — no checkpoint: a FULL pass. Counter stays 0.
    await adjust(wh.warehouseId, eachSkuId, bin, 1);
    expect(await facade.reconcile(tenantId, wh.warehouseId)).toMatchObject({
      advanced: true,
      previousSeq: null,
      watermark: 1,
    });
    expect(await checkpointRow(wh.warehouseId)).toMatchObject({
      last_seq: 1,
      incremental_count: 0,
    });

    // Cycle 2 — bounded (counter 0 < 2): clean advance, counter 1.
    await adjust(wh.warehouseId, eachSkuId, bin, 1);
    expect(await facade.reconcile(tenantId, wh.warehouseId)).toMatchObject({
      advanced: true,
      previousSeq: 1,
      watermark: 2,
    });
    expect(await checkpointRow(wh.warehouseId)).toMatchObject({
      last_seq: 2,
      incremental_count: 1,
    });

    // Cycle 3 — bounded again (counter 1 < 2): counter 2.
    await adjust(wh.warehouseId, eachSkuId, bin, 1);
    expect(await facade.reconcile(tenantId, wh.warehouseId)).toMatchObject({
      advanced: true,
      previousSeq: 2,
      watermark: 3,
    });
    expect(await checkpointRow(wh.warehouseId)).toMatchObject({
      last_seq: 3,
      incremental_count: 2,
    });

    // Cycle 4 — the counter has reached the knob: a FULL pass. The reset to 0
    // is the only observable this cycle was full rather than bounded (a third
    // bounded pass would have written 3).
    await adjust(wh.warehouseId, eachSkuId, bin, 1);
    expect(await facade.reconcile(tenantId, wh.warehouseId)).toMatchObject({
      advanced: true,
      previousSeq: 3,
      watermark: 4,
    });
    expect(await checkpointRow(wh.warehouseId)).toMatchObject({
      last_seq: 4,
      incremental_count: 0,
    });

    // …and the march resumes: the next cycle is bounded again (counter 1).
    await adjust(wh.warehouseId, eachSkuId, bin, 1);
    expect(await facade.reconcile(tenantId, wh.warehouseId)).toMatchObject({
      advanced: true,
      previousSeq: 4,
      watermark: 5,
    });
    expect(await checkpointRow(wh.warehouseId)).toMatchObject({
      last_seq: 5,
      incremental_count: 1,
    });
  });

  /** The batch row a batch-armed adjustment created, by (sku, code). */
  async function batchIdFor(skuId: string, code: string): Promise<string> {
    const rows = await sql`
      select id from batches
      where tenant_id = ${tenantId} and sku_id = ${skuId} and code = ${code}
    `;
    expect(rows).toHaveLength(1);
    return (rows[0] as unknown as { id: string }).id;
  }

});