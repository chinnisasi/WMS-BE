import { sql as dsql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import * as schema from '../src/shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../src/shared/db/tenant-scope';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

// The suite talks to the real Postgres (docker-compose dev DB by default; CI
// provides the service container). No app boots here — this suite is about
// the DATABASE (CAP-2: "proven by a database-level probe, not only an API
// test"), so its fixtures are direct SQL by design.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';

/** The advisory key every suite uses to serialize wms_rls_probe role setup. */
const PROBE_LOCK = 742105;
/** Genesis chain predecessor (AD-16) — any text works for probe events. */
const GENESIS = '0'.repeat(64);

/**
 * Story 21-2 — the four stamped tables. The migration walk is 0041's
 * (policy-only); this list is what its clauses are written against, so a
 * table stamped `client_id` later without a probe here is a table whose
 * client isolation ships unproven.
 */
const STAMPED_TABLES: readonly string[] = [
  'skus',
  'orders',
  'purchase_orders',
  'ledger_events',
  // Story 21-3 — the billing module's rate cards, born stamped (AD-24): a
  // card and each of its lines carry the client they price.
  'rate_cards',
  'rate_card_lines',
  // Story 21-4 — the storage snapshots and their per-scope watermark, born
  // stamped: a client's daily stock is its own commercial fact.
  'storage_snapshots',
  'storage_snapshot_progress',
  // Story 21-6 — the advance shipment notice header, born stamped: an ASN is
  // an inbound document authored for one client (the purchase_orders shape —
  // reads AND writes carry the clause; 21-7's portal announces shipments).
  'advance_shipment_notices',
];

/** The five policies migration 0041 recreated with the client clause. */
const CLIENT_POLICIES: readonly { table: string; policy: string; column: string }[] = [
  { table: 'skus', policy: 'skus_tenant_isolation', column: 'client_id' },
  { table: 'ledger_events', policy: 'ledger_events_tenant_isolation', column: 'client_id' },
  { table: 'purchase_orders', policy: 'purchase_orders_tenant_isolation', column: 'client_id' },
  { table: 'orders', policy: 'orders_tenant_isolation', column: 'client_id' },
  { table: 'clients', policy: 'clients_tenant_isolation', column: 'id' },
];

/**
 * Story 21-3 (0060) — the rate-card tables are born with the client clause
 * on READS only (`*_tenant_isolation`, FOR SELECT); every write policy is
 * operator-only (`app.client_id` must be unset), so a portal session reads
 * its own price list and can never edit it.
 */
const READ_ONLY_CLIENT_TABLES: readonly string[] = [
  'rate_cards',
  'rate_card_lines',
  // Story 21-4 (0061) — the same shape: a portal session reads its own
  // client's snapshots and can never write one.
  'storage_snapshots',
  'storage_snapshot_progress',
];

describe('story 21-2: client isolation RLS — app.client_id, the stamping primitive, the DB probe', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // The fixtures: ONE tenant, TWO clients (the system-owned `self` client and
  // a second non-self client seeded by direct SQL — this suite probes the
  // database itself, so it seeds below the API on purpose; the client admin
  // API (story 21-2b) is exercised in `test/clients.spec.ts`), and rows for
  // BOTH clients in every probed table. A single-client
  // fixture could pass with a policy that hid everything.
  // ──────────────────────────────────────────────────────────────────────────
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let tenantId: string;
  let warehouseId: string;
  let binId: string;
  /** The portal session's client — the tenant's system-owned `self` client. */
  let clientA: string;
  /** The sibling client the portal session must never see. */
  let clientB: string;
  let skuAId: string;
  let skuBId: string;
  /** Client A's draft rate card (story 21-3) — the own-client line insert targets it. */
  let rateCardAId: string;
  /** Story 21-5 — per client: an ISSUED September invoice and a DRAFT October one. */
  const invoiceIds = new Map<string, { issued: string; draft: string }>();
  /** Story 21-6 — per client: one announced ASN. */
  const asnIds = new Map<string, string>();

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('clientisol');
    sql = postgres(process.env.DATABASE_URL!, { max: 4 });

    tenantId = uuidv7();
    warehouseId = uuidv7();
    binId = uuidv7();
    const zoneId = uuidv7();
    const vendorId = uuidv7();
    clientA = uuidv7();
    clientB = uuidv7();
    skuAId = uuidv7();
    skuBId = uuidv7();
    const batchAId = uuidv7();
    const batchBId = uuidv7();
    const actorId = uuidv7();
    const at = new Date().toISOString();

    await sql`insert into tenants (id, tenant_id, name) values (${tenantId}, ${tenantId}, ${'Isolation Co ' + ulid()})`;
    await sql`insert into warehouses (id, tenant_id, code, name) values (${warehouseId}, ${tenantId}, 'CI', 'Isolation WH')`;
    await sql`insert into zones (id, tenant_id, warehouse_id, code, name) values (${zoneId}, ${tenantId}, ${warehouseId}, 'A', 'Aisle A')`;
    await sql`insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type) values (${binId}, ${tenantId}, ${warehouseId}, ${zoneId}, 'A-01-01', 1000000, 'shelf')`;

    // The self client (identity: code 'self' + system_owned — the predicate
    // every probe below uses) and the sibling client a portal session must
    // not see.
    await sql`insert into clients (id, tenant_id, code, name, status, system_owned)
      values (${clientA}, ${tenantId}, 'self', 'Isolation Co', 'active', true)`;
    // (Codes uppercase since story 21-2b's 0059 CHECK `clients_code_format`.)
    await sql`insert into clients (id, tenant_id, code, name, status, system_owned)
      values (${clientB}, ${tenantId}, 'BRAND-B', 'Brand B', 'active', false)`;

    await sql`insert into skus (id, tenant_id, client_id, code, name, uom, gst_rate_bps, barcode)
      values (${skuAId}, ${tenantId}, ${clientA}, 'CI-SKU-A', 'Isolation SKU A', 'each', 1800, ${ulid()})`;
    await sql`insert into skus (id, tenant_id, client_id, code, name, uom, gst_rate_bps, barcode)
      values (${skuBId}, ${tenantId}, ${clientB}, 'CI-SKU-B', 'Isolation SKU B', 'each', 1800, ${ulid()})`;

    await sql`insert into vendors (id, tenant_id, code, name) values (${vendorId}, ${tenantId}, 'CI-V', 'Isolation Vendor')`;
    await sql`insert into purchase_orders (id, tenant_id, client_id, warehouse_id, vendor_id, code, status)
      values (${uuidv7()}, ${tenantId}, ${clientA}, ${warehouseId}, ${vendorId}, 'CI-PO-A', 'open')`;
    await sql`insert into purchase_orders (id, tenant_id, client_id, warehouse_id, vendor_id, code, status)
      values (${uuidv7()}, ${tenantId}, ${clientB}, ${warehouseId}, ${vendorId}, 'CI-PO-B', 'open')`;

    await sql`insert into orders (id, tenant_id, client_id, warehouse_id, status, source)
      values (${uuidv7()}, ${tenantId}, ${clientA}, ${warehouseId}, 'accepted', 'manual')`;
    await sql`insert into orders (id, tenant_id, client_id, warehouse_id, status, source)
      values (${uuidv7()}, ${tenantId}, ${clientB}, ${warehouseId}, 'accepted', 'manual')`;

    // Story 21-6 — one ASN (with one line) per client. The lines carry no
    // client column: their visibility rides the parent header.
    for (const [clientId, skuId] of [
      [clientA, skuAId],
      [clientB, skuBId],
    ] as const) {
      const asnId = uuidv7();
      asnIds.set(clientId, asnId);
      await sql`insert into advance_shipment_notices (id, tenant_id, client_id, warehouse_id, asn_code, status)
        values (${asnId}, ${tenantId}, ${clientId}, ${warehouseId}, 'CI-ASN', 'announced')`;
      await sql`insert into asn_lines (id, tenant_id, asn_id, sku_id, announced_qty)
        values (${uuidv7()}, ${tenantId}, ${asnId}, ${skuId}, 4000)`;
    }

    // One ledger event per client — billing aggregates over this table
    // constantly, so it is probed with the rest.
    for (const [seq, clientId, skuId] of [
      [1, clientA, skuAId],
      [2, clientB, skuBId],
    ] as const) {
      await sql`
        insert into ledger_events (
          id, tenant_id, client_id, warehouse_id, seq, type, schema_version, sku_id, quantity_delta,
          to_bin_id, actor_user_id, occurred_at, recorded_at, reference_doc, prev_hash, event_hash
        ) values (
          ${uuidv7()}, ${tenantId}, ${clientId}, ${warehouseId}, ${seq}, 'stock.adjusted', 1, ${skuId}, 1000,
          ${binId}, ${actorId}, ${at}, ${at}, ${sql.json({ kind: 'manual-adjustment', reasonCode: 'seed' })}, ${GENESIS}, ${'seed-hash-' + clientId}
        )
      `;
    }

    // Story 21-3 — one DRAFT rate card per client, each with a line (a
    // draft, so the freeze triggers admit the line; the probe is about who
    // can SEE them — and that a portal session can write none of them).
    for (const clientId of [clientA, clientB]) {
      const cardId = uuidv7();
      if (clientId === clientA) rateCardAId = cardId;
      await sql`insert into rate_cards (id, tenant_id, client_id, status, created_by)
        values (${cardId}, ${tenantId}, ${clientId}, 'draft', ${actorId})`;
      await sql`insert into rate_card_lines (id, tenant_id, client_id, rate_card_id, charge_code, basis, amount_paise)
        values (${uuidv7()}, ${tenantId}, ${clientId}, ${cardId}, 'storage', 'per_thousand_units_per_day', 330)`;
    }

    // Story 21-4 — one snapshot row and one watermark per client (seeded
    // below the API: the probe is about who can SEE them).
    for (const clientId of [clientA, clientB]) {
      await sql`insert into storage_snapshots (id, tenant_id, client_id, warehouse_id, snapshot_date, uom, on_hand_milli)
        values (${uuidv7()}, ${tenantId}, ${clientId}, ${warehouseId}, '2026-09-01', 'each', 5000)`;
      await sql`insert into storage_snapshot_progress (tenant_id, client_id, warehouse_id, last_day, running)
        values (${tenantId}, ${clientId}, ${warehouseId}, '2026-09-01', ${sql.json({ each: '5000' })})`;
    }

    // Story 21-5 — per client, an ISSUED invoice (September) and a DRAFT one
    // (October), each with one line, plus a services series row. A line is
    // written only under a draft (the lines trigger), so the September
    // invoice is born a draft and then issued — through the guard trigger.
    for (const clientId of [clientA, clientB]) {
      const ids = { issued: uuidv7(), draft: uuidv7() };
      invoiceIds.set(clientId, ids);
      for (const [id, periodStart, periodEnd, segmentFrom, segmentTo] of [
        [ids.issued, '2026-09-01', '2026-09-30', '2026-08-31T18:30:00Z', '2026-09-30T18:30:00Z'],
        [ids.draft, '2026-10-01', '2026-10-31', '2026-09-30T18:30:00Z', '2026-10-31T18:30:00Z'],
      ] as const) {
        await sql`insert into client_invoices (id, tenant_id, client_id, period_start, period_end, status, supplier_gstin,
            place_of_supply, supply_type, subtotal_paise, cgst_paise, sgst_paise, igst_paise, tax_paise, total_paise,
            round_off_paise, payable_paise, gaps, warnings, party, content_hash, created_by)
          values (${id}, ${tenantId}, ${clientId}, ${periodStart}, ${periodEnd}, 'draft', '29ABCDE1234F1Z5',
            '29', 'intra', 3000, 270, 270, 0, 540, 3540, -40, 3500, '[]'::jsonb, '[]'::jsonb, '{"seed": true}'::jsonb, 'seed', ${actorId})`;
        await sql`insert into client_invoice_lines (id, tenant_id, invoice_id, rate_card_id, segment_from, segment_to, charge_code, basis,
            uom, quantity, unit_amount_paise, amount_paise, sac_code, gst_bps, place_of_supply, supply_type, cgst_paise, sgst_paise, igst_paise)
          values (${uuidv7()}, ${tenantId}, ${id}, ${uuidv7()}, ${segmentFrom}, ${segmentTo}, 'pick', 'per_pick',
            null, 10, 300, 3000, '996719', 1800, '29', 'intra', 270, 270, 0)`;
      }
      await sql`update client_invoices set status = 'issued', invoice_no = ${'29/S2627/00000' + (clientId === clientA ? '1' : '2')},
          fy_label = 'FY-2627', series_seq = ${clientId === clientA ? 1 : 2}, issued_at = now(), issued_by = ${actorId}
        where id = ${ids.issued}`;
    }
    await sql`insert into client_invoice_series (id, tenant_id, supplier_gstin, fy_label, last_seq)
      values (${uuidv7()}, ${tenantId}, '29ABCDE1234F1Z5', 'FY-2627', 2)`;

    // The INHERITED rows: stock and batch rows carry no client_id — their
    // isolation rides the SKU join, which the skus policy now filters.
    await sql`insert into batches (id, tenant_id, sku_id, code) values (${batchAId}, ${tenantId}, ${skuAId}, 'CI-B-A')`;
    await sql`insert into batches (id, tenant_id, sku_id, code) values (${batchBId}, ${tenantId}, ${skuBId}, 'CI-B-B')`;
    await sql`insert into stock_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, quantity)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${skuAId}, ${binId}, 5000)`;
    await sql`insert into stock_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, quantity)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${skuBId}, ${binId}, 7000)`;
    await sql`insert into batch_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, batch_id, quantity)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${skuAId}, ${binId}, ${batchAId}, 5000)`;
    await sql`insert into batch_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, batch_id, quantity)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${skuBId}, ${binId}, ${batchBId}, 7000)`;

    // Story 5-2's two tables — tenant-scoped RLS with the same fail-closed
    // idiom but NO client column. Seeded so the no-tenant probe's zero below
    // is the policy's answer, not an empty table.
    await sql`insert into stock_adjustment_policies (id, tenant_id, quantity_threshold)
      values (${uuidv7()}, ${tenantId}, 10)`;
    await sql`insert into stock_adjustment_pendings (
      id, tenant_id, warehouse_id, bin_id, sku_id, quantity_milli, reason_code, note,
      occurred_at, requested_by, requested_at, status, threshold_quantity_at_request
    ) values (
      ${uuidv7()}, ${tenantId}, ${warehouseId}, ${binId}, ${skuAId}, 11000, 'stock-count', 'probe seed',
      ${at}, ${actorId}, ${at}, 'pending', 10
    )`;
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
    await suiteDb?.drop();
  });

  // Count via a BUILT query, not a string: the table goes through the tagged
  // template as an identifier (`${t('skus')}`) and every value is bound by the
  // template — no string interpolation of table or predicate, no unsafe().
  async function expectCount(
    build: (t: postgres.Sql<Record<string, unknown>>) => PromiseLike<unknown>,
    expected: number,
  ): Promise<void> {
    const rows = (await build(sql)) as unknown[];
    expect(Number((rows[0] as unknown as { n: number }).n)).toBe(expected);
  }

  // The probe role: cluster-global in the template, re-ensured under the
  // shared advisory key the way every probe suite does — concurrent CREATE
  // ROLE / GRANT ON ALL TABLES from sibling suites trip "tuple concurrently
  // updated" on the shared catalog rows.
  function probeUrl(): string {
    const url = new URL(process.env.DATABASE_URL!);
    url.username = 'wms_rls_probe';
    url.password = 'wms_rls_probe';
    return url.toString();
  }

  async function ensureProbeRole(): Promise<void> {
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${PROBE_LOCK})`;
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
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Part 1 — the stamping primitive (src/shared/db/tenant-scope.ts). The
  // session-variable plumbing 21-7's portal sessions will consume.
  // ──────────────────────────────────────────────────────────────────────────
  describe('the client stamping primitive (withTenantTransaction options.clientId)', () => {
    // ONE physical connection (max 1) so the "dies with the transaction" pin
    // is deterministic: a session-scoped leak would be visible on the very
    // next transaction the pool hands out.
    let db: PostgresJsDatabase<typeof schema>;

    beforeAll(() => {
      db = drizzle(postgres(process.env.DATABASE_URL!, { max: 1 }), { schema });
    });

    afterAll(async () => {
      const rawDb = db as unknown as { $client?: { end(): Promise<void> } };
      await rawDb.$client?.end();
    });

    async function readSettings(tx: TenantTx): Promise<{ t: string | null; c: string | null }> {
      // Read through the SAME normalization the policies use: PG18 returns ''
      // for an expired transaction-local setting, and the NULLIF is what turns
      // that into the operator shape. Asserting on the raw current_setting
      // would pin NULL where the idiom accepts '' and NULL alike.
      const rows = (await tx.execute(
        dsql`select current_setting('app.tenant_id', true) as t,
               nullif(current_setting('app.client_id', true), '') as c`,
      )) as unknown as { t: string | null; c: string | null }[];
      return rows[0]!;
    }

    it('stamps BOTH variables inside the transaction when clientId is given', async () => {
      await withTenantTransaction(
        db,
        tenantId,
        async (tx) => {
          const settings = await readSettings(tx);
          expect(settings.t).toBe(tenantId);
          expect(settings.c).toBe(clientA);
        },
        { clientId: clientA },
      );
    });

    it('REJECTS an empty-string clientId — the one input that would silently stamp the operator shape (the policy NULLIF reads "" as unset)', async () => {
      await expect(
        withTenantTransaction(db, tenantId, async () => undefined, { clientId: '' }),
      ).rejects.toThrow(/clientId "" is rejected/);
    });

    it('leaves app.client_id UNTOUCHED when clientId is omitted — the operator shape is preserved', async () => {
      await withTenantTransaction(db, tenantId, async (tx) => {
        const settings = await readSettings(tx);
        expect(settings.t).toBe(tenantId);
        expect(settings.c).toBeNull();
      });
    });

    it('the client scope dies with the transaction (set_config(..., true) — transaction-local)', async () => {
      await withTenantTransaction(
        db,
        tenantId,
        async () => undefined,
        { clientId: clientA },
      );
      // The same single pooled connection — a session-scoped stamp would
      // still read as clientA here. Transaction-local means it does not.
      await withTenantTransaction(db, tenantId, async (tx) => {
        const settings = await readSettings(tx);
        expect(settings.c).toBeNull();
      });
    });

    it('through a NON-SUPERUSER session the stamp binds the RLS client clause (the drizzle path 21-7 consumes)', async () => {
      await ensureProbeRole();
      const probeDb = drizzle(postgres(probeUrl(), { max: 1 }), { schema });
      try {
        // Portal-shaped: only client A's SKU rows exist.
        const own = await withTenantTransaction(
          probeDb,
          tenantId,
          async (tx) => tx.select({ clientId: schema.skus.clientId }).from(schema.skus),
          { clientId: clientA },
        );
        expect(own.map((row) => row.clientId)).toEqual([clientA]);

        // Stamped with the SIBLING's id: the clause binds to its own rows —
        // client A's are the ones that vanish.
        const sibling = await withTenantTransaction(
          probeDb,
          tenantId,
          async (tx) => tx.select({ clientId: schema.skus.clientId }).from(schema.skus),
          { clientId: clientB },
        );
        expect(sibling.map((row) => row.clientId)).toEqual([clientB]);

        // Operator-shaped (option omitted): BOTH clients visible — the whole
        // tenant, exactly as every existing call site sees it today.
        const all = await withTenantTransaction(
          probeDb,
          tenantId,
          async (tx) => tx.select({ clientId: schema.skus.clientId }).from(schema.skus),
        );
        expect(all).toHaveLength(2);
        expect(new Set(all.map((row) => row.clientId))).toEqual(new Set([clientA, clientB]));
      } finally {
        const rawDb = probeDb as unknown as { $client?: { end(): Promise<void> } };
        await rawDb.$client?.end();
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Part 2 — the DB-level isolation probe. Every read below runs as the
  // non-superuser wms_rls_probe role: the database, not the application,
  // is what makes the sibling client's rows unreachable (CAP-2).
  // ──────────────────────────────────────────────────────────────────────────
  describe('the DB-level isolation probe (wms_rls_probe)', () => {
    let probe: postgres.Sql<Record<string, unknown>>;

    beforeAll(async () => {
      await ensureProbeRole();
      probe = postgres(probeUrl(), { max: 1 });
    });

    afterAll(async () => {
      await probe?.end();
    });

    /** A portal-shaped probe transaction: tenant + client both stamped. */
    function portal(
      run: (tx: postgres.TransactionSql<Record<string, unknown>>) => Promise<unknown>,
      client: string = clientA,
    ): Promise<unknown[]> {
      return probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        await tx`select set_config('app.client_id', ${client}, true)`;
        return (await run(tx)) as unknown[];
      });
    }

    /** An operator-shaped probe transaction: the tenant stamped, the client NEVER. */
    function operator(
      run: (tx: postgres.TransactionSql<Record<string, unknown>>) => Promise<unknown>,
    ): Promise<unknown[]> {
      return probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        return (await run(tx)) as unknown[];
      });
    }

    function countOf(rows: unknown[]): number {
      return Number((rows[0] as unknown as { n: number }).n);
    }

    it('a PORTAL-shaped session sees its own rows and ZERO of the sibling client’s, on every stamped table', async () => {
      for (const table of STAMPED_TABLES) {
        // The sibling's rows exist in the table (seeded; the operator probe
        // below counts them) — they are invisible here.
        const foreign = await portal((tx) =>
          tx`select count(*)::int as n from ${probe(table)} where tenant_id = ${tenantId} and client_id = ${clientB}`,
        );
        expect(countOf(foreign)).toBe(0);

        // …and even WITHOUT the tenant predicate — the policy is the filter.
        const foreignBlind = await portal((tx) =>
          tx`select count(*)::int as n from ${probe(table)} where client_id = ${clientB}`,
        );
        expect(countOf(foreignBlind)).toBe(0);

        // Own rows are visible through the same session.
        const own = await portal((tx) =>
          tx`select count(*)::int as n from ${probe(table)} where tenant_id = ${tenantId} and client_id = ${clientA}`,
        );
        expect(countOf(own)).toBeGreaterThan(0);
      }
    });

    it('an OPERATOR-shaped session (client unset) still sees BOTH clients — isolation did not partition the tenant', async () => {
      for (const table of STAMPED_TABLES) {
        const counts = await operator((tx) =>
          tx`select client_id, count(*)::int as n from ${probe(table)} where tenant_id = ${tenantId} group by client_id`,
        );
        const rows = counts as unknown as { client_id: string; n: number }[];
        const byClient = new Map(rows.map((row) => [row.client_id, Number(row.n)]));
        expect(byClient.get(clientA)).toBeGreaterThan(0);
        expect(byClient.get(clientB)).toBeGreaterThan(0);
      }

      // The 5-2 tables carry no client column — tenant-scoped, so the
      // operator shape sees the seeded rows. This is what makes the
      // no-tenant probe's zero (below) the policy's answer, not an empty
      // table.
      const pendings = await operator((tx) =>
        tx`select count(*)::int as n from stock_adjustment_pendings where tenant_id = ${tenantId}`,
      );
      expect(countOf(pendings)).toBe(1);
      const policies = await operator((tx) =>
        tx`select count(*)::int as n from stock_adjustment_policies where tenant_id = ${tenantId}`,
      );
      expect(countOf(policies)).toBe(1);
    });

    it('a session with NO tenant variable sees zero rows (the existing fail-closed idiom is intact)', async () => {
      // Story 5-2's two tables ride the same idiom — probed here so a table
      // stamped with the tenant-isolation policy later without a probe here
      // cannot ship fail-open.
      for (const table of [
        ...STAMPED_TABLES,
        'clients',
        'stock_adjustment_pendings',
        'stock_adjustment_policies',
      ]) {
        const unscoped = await probe.unsafe(
          `select count(*)::int as n from ${table} where tenant_id = '${tenantId}'::uuid`,
        );
        expect(countOf(unscoped)).toBe(0);
      }
    });

    it('a set-but-WRONG client id binds to nothing (fail-closed, not fail-open)', async () => {
      const wrong = await probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        await tx`select set_config('app.client_id', ${uuidv7()}, true)`;
        return tx`select count(*)::int as n from skus where tenant_id = ${tenantId}`;
      });
      expect(countOf(wrong)).toBe(0);
    });

    it("a raw '' stamp is the OPERATOR shape at the policy level — the NULLIF contract ('' = unset)", async () => {
      // The deliberate contract, pinned where it is load-bearing: an expired
      // transaction-local setting reads as '' (PG18), and the policies' NULLIF
      // turns '' into UNSET — the whole tenant, not a bind-to-nothing empty
      // client. Set-but-wrong binds to nothing (above); '' is the operator.
      const counts = await probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        await tx`select set_config('app.client_id', '', true)`;
        return tx`select client_id, count(*)::int as n from skus where tenant_id = ${tenantId} group by client_id`;
      });
      const rows = counts as unknown as { client_id: string; n: number }[];
      const byClient = new Map(rows.map((row) => [row.client_id, Number(row.n)]));
      expect(byClient.get(clientA)).toBeGreaterThan(0);
      expect(byClient.get(clientB)).toBeGreaterThan(0);
    });

    it('the WITH CHECK arm rejects a foreign-client INSERT with 42501, on every stamped table (rate-card lines: the freeze trigger fails closed first)', async () => {
      for (const table of STAMPED_TABLES) {
        let rejected: Promise<unknown>;
        if (table === 'skus') {
          rejected = portal((tx) =>
            tx`insert into skus (id, tenant_id, client_id, code, name, uom, gst_rate_bps, barcode)
              values (${uuidv7()}, ${tenantId}, ${clientB}, 'CI-PROBE-F', 'Foreign SKU', 'each', 1800, ${ulid()})`,
          );
        } else if (table === 'orders') {
          rejected = portal((tx) =>
            tx`insert into orders (id, tenant_id, client_id, warehouse_id, status, source)
              values (${uuidv7()}, ${tenantId}, ${clientB}, ${warehouseId}, 'accepted', 'manual')`,
          );
        } else if (table === 'purchase_orders') {
          rejected = portal((tx) =>
            tx`insert into purchase_orders (id, tenant_id, client_id, warehouse_id, vendor_id, code, status)
              values (
                ${uuidv7()}, ${tenantId}, ${clientB}, ${warehouseId},
                (select id from vendors where tenant_id = ${tenantId} and code = 'CI-V' limit 1),
                'CI-PO-FOREIGN', 'open'
              )`,
          );
        } else if (table === 'rate_cards') {
          rejected = portal((tx) =>
            tx`insert into rate_cards (id, tenant_id, client_id, status, created_by)
              values (${uuidv7()}, ${tenantId}, ${clientB}, 'draft', ${uuidv7()})`,
          );
        } else if (table === 'rate_card_lines') {
          // A foreign-client line is refused BEFORE the WITH CHECK arm runs:
          // the freeze trigger reads the parent card through the same RLS
          // session, and client B's card is invisible to a client-A portal
          // session — the parent reads as missing and the trigger fails
          // closed (P0001). Refused at the database either way.
          await expect(
            portal((tx) =>
              tx`insert into rate_card_lines (id, tenant_id, client_id, rate_card_id, charge_code, basis, amount_paise)
                values (
                  ${uuidv7()}, ${tenantId}, ${clientB},
                  (select id from rate_cards where tenant_id = ${tenantId} and client_id = ${clientB} limit 1),
                  'pick', 'per_pick', 100
                )`,
            ),
          ).rejects.toMatchObject({ code: 'P0001' });
          // (The 42501 WITH CHECK arm itself is pinned on rate_cards above —
          // a line can only be written under a card the session can see.)
          continue;
        } else if (table === 'storage_snapshots') {
          rejected = portal((tx) =>
            tx`insert into storage_snapshots (id, tenant_id, client_id, warehouse_id, snapshot_date, uom, on_hand_milli)
              values (${uuidv7()}, ${tenantId}, ${clientB}, ${warehouseId}, '2026-09-02', 'each', 1000)`,
          );
        } else if (table === 'storage_snapshot_progress') {
          rejected = portal((tx) =>
            tx`insert into storage_snapshot_progress (tenant_id, client_id, warehouse_id, last_day, running)
              values (${tenantId}, ${clientB}, ${uuidv7()}, '2026-09-02', '{}'::jsonb)`,
          );
        } else if (table === 'advance_shipment_notices') {
          rejected = portal((tx) =>
            tx`insert into advance_shipment_notices (id, tenant_id, client_id, warehouse_id, asn_code)
              values (${uuidv7()}, ${tenantId}, ${clientB}, ${warehouseId}, 'CI-ASN-FOREIGN')`,
          );
        } else {
          rejected = portal((tx) =>
            tx`insert into ledger_events (
                id, tenant_id, client_id, warehouse_id, seq, type, schema_version, sku_id, quantity_delta,
                actor_user_id, occurred_at, recorded_at, reference_doc, prev_hash, event_hash
              ) values (
                ${uuidv7()}, ${tenantId}, ${clientB}, ${warehouseId}, 9100, 'stock.adjusted', 1, ${skuBId}, 1,
                ${uuidv7()}, now(), now(), ${sql.json({ kind: 'manual-adjustment', reasonCode: 'probe' })}, ${GENESIS}, ${GENESIS}
              )`,
          );
        }
        await expect(rejected).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('the WITH CHECK arm allows a portal session’s OWN-client inserts, on all four stamped tables', async () => {
      // The own-client rows these inserts leave behind (the ledger event can
      // never be deleted — the append-only guard — so its seq sits far from
      // every fixture's; every other probe counts foreign-vs-own, which the
      // extra own rows do not disturb).
      await portal((tx) =>
        tx`insert into skus (id, tenant_id, client_id, code, name, uom, gst_rate_bps, barcode)
          values (${uuidv7()}, ${tenantId}, ${clientA}, 'CI-PROBE-OWN', 'Own SKU', 'each', 1800, ${ulid()})`,
      );
      await portal((tx) =>
        tx`insert into orders (id, tenant_id, client_id, warehouse_id, status, source)
          values (${uuidv7()}, ${tenantId}, ${clientA}, ${warehouseId}, 'accepted', 'manual')`,
      );
      await portal((tx) =>
        tx`insert into purchase_orders (id, tenant_id, client_id, warehouse_id, vendor_id, code, status)
          values (
            ${uuidv7()}, ${tenantId}, ${clientA}, ${warehouseId},
            (select id from vendors where tenant_id = ${tenantId} and code = 'CI-V' limit 1),
            'CI-PO-OWN', 'open'
          )`,
      );
      await portal((tx) =>
        tx`insert into ledger_events (
            id, tenant_id, client_id, warehouse_id, seq, type, schema_version, sku_id, quantity_delta,
            actor_user_id, occurred_at, recorded_at, reference_doc, prev_hash, event_hash
          ) values (
            ${uuidv7()}, ${tenantId}, ${clientA}, ${warehouseId}, 9101, 'stock.adjusted', 1, ${skuAId}, 1,
            ${uuidv7()}, now(), now(), ${sql.json({ kind: 'manual-adjustment', reasonCode: 'probe' })}, ${GENESIS}, ${GENESIS}
          )`,
      );

      // All four landed, stamped with the session's client.
      await expectCount(
        (t) => t`select count(*)::int as n from ${t('skus')} where tenant_id = ${tenantId} and code = 'CI-PROBE-OWN'`,
        1,
      );
      await expectCount(
        (t) => t`select count(*)::int as n from ${t('orders')} where tenant_id = ${tenantId} and client_id = ${clientA}`,
        2,
      );
      await expectCount(
        (t) => t`select count(*)::int as n from ${t('purchase_orders')} where tenant_id = ${tenantId} and code = 'CI-PO-OWN'`,
        1,
      );
      await expectCount(
        (t) => t`select count(*)::int as n from ${t('ledger_events')} where tenant_id = ${tenantId} and seq = 9101`,
        1,
      );
    });

    it('ASN lines inherit the header: a portal session sees, and writes, only lines under its own client’s ASN (21-6)', async () => {
      const ownAsn = asnIds.get(clientA)!;
      const foreignAsn = asnIds.get(clientB)!;
      const lines = await portal((tx) => tx`select asn_id from asn_lines where tenant_id = ${tenantId}`);
      expect((lines as unknown as { asn_id: string }[]).map((row) => row.asn_id)).toEqual([ownAsn]);
      expect(countOf(await operator((tx) => tx`select count(*)::int as n from asn_lines where tenant_id = ${tenantId}`))).toBe(2);
      // A line under the sibling's ASN: the parent is invisible, so the
      // inherited WITH CHECK refuses it.
      await expect(
        portal((tx) =>
          tx`insert into asn_lines (id, tenant_id, asn_id, sku_id, announced_qty)
            values (${uuidv7()}, ${tenantId}, ${foreignAsn}, ${skuBId}, 1000)`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      // A line under its own ASN lands.
      await portal((tx) =>
        tx`insert into asn_lines (id, tenant_id, asn_id, sku_id, announced_qty)
          values (${uuidv7()}, ${tenantId}, ${ownAsn}, ${skuAId}, 1000)`,
      );
      expect(countOf(await operator((tx) => tx`select count(*)::int as n from asn_lines where asn_id = ${ownAsn}`))).toBe(2);
      // No tenant variable: nothing.
      const unscoped = await probe.unsafe(`select count(*)::int as n from asn_lines where tenant_id = '${tenantId}'::uuid`);
      expect(countOf(unscoped)).toBe(0);
    });

    it('rate cards are READ-ONLY to a portal session: it reads its own, and cannot insert, update or delete even its own (21-3)', async () => {
      // Reads: its own card and line, none of the sibling's (the read clause).
      const own = await portal((tx) => tx`select id from rate_cards where tenant_id = ${tenantId}`);
      expect((own as unknown as { id: string }[]).map((row) => row.id)).toEqual([rateCardAId]);
      const ownLines = await portal((tx) => tx`select count(*)::int as n from rate_card_lines where tenant_id = ${tenantId}`);
      expect(countOf(ownLines)).toBe(1);

      // INSERT of its OWN client's card: the operator-only WITH CHECK refuses.
      await expect(
        portal((tx) =>
          tx`insert into rate_cards (id, tenant_id, client_id, status, created_by)
            values (${uuidv7()}, ${tenantId}, ${clientA}, 'draft', ${uuidv7()})`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      // A line on its OWN draft: the freeze trigger's parent lookup (FOR
      // SHARE, which needs the operator-only UPDATE policy) sees no parent
      // and fails closed before the WITH CHECK arm (P0001).
      await expect(
        portal((tx) =>
          tx`insert into rate_card_lines (id, tenant_id, client_id, rate_card_id, charge_code, basis, amount_paise)
            values (${uuidv7()}, ${tenantId}, ${clientA}, ${rateCardAId}, 'pick', 'per_pick', 300)`,
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
      // UPDATE and DELETE of its own rows bind nothing.
      const updated = await portal((tx) => tx`update rate_card_lines set amount_paise = 1 where rate_card_id = ${rateCardAId} returning id`);
      expect(updated).toHaveLength(0);
      const deletedLines = await portal((tx) => tx`delete from rate_card_lines where rate_card_id = ${rateCardAId} returning id`);
      expect(deletedLines).toHaveLength(0);
      const deletedCards = await portal((tx) => tx`delete from rate_cards where id = ${rateCardAId} returning id`);
      expect(deletedCards).toHaveLength(0);
      await expectCount((t) => t`select count(*)::int as n from ${t('rate_card_lines')} where rate_card_id = ${rateCardAId} and amount_paise = 330`, 1);
      await expectCount((t) => t`select count(*)::int as n from ${t('rate_cards')} where tenant_id = ${tenantId}`, 2);
    });

    it('storage snapshots are READ-ONLY to a portal session: it reads its own, and cannot insert, update or delete even its own (21-4)', async () => {
      const own = await portal((tx) => tx`select client_id from storage_snapshots where tenant_id = ${tenantId}`);
      expect((own as unknown as { client_id: string }[]).map((row) => row.client_id)).toEqual([clientA]);
      const ownProgress = await portal((tx) => tx`select client_id from storage_snapshot_progress where tenant_id = ${tenantId}`);
      expect((ownProgress as unknown as { client_id: string }[]).map((row) => row.client_id)).toEqual([clientA]);

      // INSERT of its OWN client's rows: the operator-only WITH CHECK refuses.
      await expect(
        portal((tx) =>
          tx`insert into storage_snapshots (id, tenant_id, client_id, warehouse_id, snapshot_date, uom, on_hand_milli)
            values (${uuidv7()}, ${tenantId}, ${clientA}, ${warehouseId}, '2026-09-03', 'each', 1000)`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        portal((tx) =>
          tx`insert into storage_snapshot_progress (tenant_id, client_id, warehouse_id, last_day, running)
            values (${tenantId}, ${clientA}, ${uuidv7()}, '2026-09-03', '{}'::jsonb)`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      // UPDATE and DELETE of its own rows bind nothing.
      expect(await portal((tx) => tx`update storage_snapshots set on_hand_milli = 1 where client_id = ${clientA} returning id`)).toHaveLength(0);
      expect(await portal((tx) => tx`update storage_snapshot_progress set last_day = '2030-01-01' where client_id = ${clientA} returning client_id`)).toHaveLength(0);
      expect(await portal((tx) => tx`delete from storage_snapshots where client_id = ${clientA} returning id`)).toHaveLength(0);
      expect(await portal((tx) => tx`delete from storage_snapshot_progress where client_id = ${clientA} returning client_id`)).toHaveLength(0);
      await expectCount((t) => t`select count(*)::int as n from ${t('storage_snapshots')} where tenant_id = ${tenantId} and on_hand_milli = 5000`, 2);
      await expectCount((t) => t`select count(*)::int as n from ${t('storage_snapshot_progress')} where tenant_id = ${tenantId} and last_day = '2026-09-01'`, 2);
    });

    it('client invoices: a portal session reads its own ISSUED invoices and their lines — never a draft, never the sibling’s — and writes nothing (21-5)', async () => {
      const own = invoiceIds.get(clientA)!;
      const rows = await portal((tx) => tx`select id from client_invoices where tenant_id = ${tenantId}`);
      expect((rows as unknown as { id: string }[]).map((row) => row.id)).toEqual([own.issued]);
      // Its own draft is invisible even by id; the sibling's issued one too.
      expect(await portal((tx) => tx`select id from client_invoices where id = ${own.draft}`)).toHaveLength(0);
      expect(await portal((tx) => tx`select id from client_invoices where id = ${invoiceIds.get(clientB)!.issued}`)).toHaveLength(0);
      // Lines INHERIT the parent's visibility: only the issued invoice's line.
      const lines = await portal((tx) => tx`select invoice_id from client_invoice_lines where tenant_id = ${tenantId}`);
      expect((lines as unknown as { invoice_id: string }[]).map((row) => row.invoice_id)).toEqual([own.issued]);
      // The series is operator-only.
      expect(countOf(await portal((tx) => tx`select count(*)::int as n from client_invoice_series where tenant_id = ${tenantId}`))).toBe(0);
      // The operator sees every invoice, line and series row.
      expect(countOf(await operator((tx) => tx`select count(*)::int as n from client_invoices where tenant_id = ${tenantId}`))).toBe(4);
      expect(countOf(await operator((tx) => tx`select count(*)::int as n from client_invoice_lines where tenant_id = ${tenantId}`))).toBe(4);
      expect(countOf(await operator((tx) => tx`select count(*)::int as n from client_invoice_series where tenant_id = ${tenantId}`))).toBe(1);
      // No tenant variable: nothing (the fail-closed idiom).
      for (const table of ['client_invoices', 'client_invoice_lines', 'client_invoice_series']) {
        expect(countOf(await probe.unsafe(`select count(*)::int as n from ${table} where tenant_id = '${tenantId}'::uuid`))).toBe(0);
      }

      // Writes: an own-client INSERT is refused by the operator-only WITH CHECK…
      await expect(
        portal((tx) =>
          tx`insert into client_invoices (id, tenant_id, client_id, period_start, period_end, status, subtotal_paise, cgst_paise,
              sgst_paise, igst_paise, tax_paise, total_paise, round_off_paise, payable_paise, gaps, warnings, party, content_hash, created_by)
            values (${uuidv7()}, ${tenantId}, ${clientA}, '2026-11-01', '2026-11-30', 'draft', 0, 0, 0, 0, 0, 0, 0, 0,
              '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 'probe', ${uuidv7()})`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      // …a line under its own draft fails closed in the lines trigger (the
      // parent is invisible to the portal — P0001 before the WITH CHECK)…
      await expect(
        portal((tx) =>
          tx`insert into client_invoice_lines (id, tenant_id, invoice_id, rate_card_id, segment_from, segment_to, charge_code, basis,
              uom, quantity, unit_amount_paise, amount_paise, sac_code, gst_bps, place_of_supply, supply_type, cgst_paise, sgst_paise, igst_paise)
            values (${uuidv7()}, ${tenantId}, ${own.draft}, null, '2026-09-30T18:30:00Z', '2026-10-31T18:30:00Z', 'pick', 'per_pick',
              null, 1, null, null, '996719', 1800, null, null, 0, 0, 0)`,
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
      // …and UPDATE / DELETE of its own rows bind nothing.
      expect(await portal((tx) => tx`update client_invoices set status_note = 'x' where client_id = ${clientA} returning id`)).toHaveLength(0);
      expect(await portal((tx) => tx`delete from client_invoice_lines where invoice_id = ${own.issued} returning id`)).toHaveLength(0);
      expect(await portal((tx) => tx`update client_invoice_series set last_seq = 99 returning id`)).toHaveLength(0);
      await expectCount((t) => t`select count(*)::int as n from ${t('client_invoices')} where tenant_id = ${tenantId} and status_note is null`, 4);
    });

    it('the UPDATE and DELETE arms bind too: a portal session cannot re-stamp its row to the sibling, and deletes ZERO of the sibling’s rows', async () => {
      // UPDATE arm (WITH CHECK on skus): the session's own row is visible
      // (USING passes) but may not be MOVED to the sibling's client.
      const foreignUpdate = portal((tx) =>
        tx`update skus set client_id = ${clientB} where id = ${skuAId}`,
      );
      await expect(foreignUpdate).rejects.toMatchObject({ code: '42501' });

      // DELETE arm (USING on skus): the sibling's rows are invisible, so a
      // delete keyed on them touches nothing.
      const foreignDelete = await portal((tx) =>
        tx`delete from skus where client_id = ${clientB} returning id`,
      );
      expect(foreignDelete).toHaveLength(0);
    });

    it('INHERITED rows ride the SKU join to the same isolation: stock_on_hand and batch_on_hand', async () => {
      // The join-shaped query is how the app actually reads batches/stock —
      // through the SKU, which the skus policy now filters.
      const joinStock = (client: string): Promise<unknown[]> =>
        portal(
          (tx) =>
            tx`select count(*)::int as n from stock_on_hand s
              join skus k on k.id = s.sku_id and k.tenant_id = s.tenant_id
              where s.tenant_id = ${tenantId} and k.client_id = ${client}`,
          client,
        );
      const joinBatches = (client: string): Promise<unknown[]> =>
        portal(
          (tx) =>
            tx`select count(*)::int as n from batch_on_hand b
              join skus k on k.id = b.sku_id and k.tenant_id = b.tenant_id
              where b.tenant_id = ${tenantId} and k.client_id = ${client}`,
          client,
        );

      // Portal A: its own row, and ZERO of client B's.
      expect(countOf(await joinStock(clientA))).toBe(1);
      expect(countOf(await joinBatches(clientA))).toBe(1);
      // Portal B: the mirror image.
      expect(countOf(await joinStock(clientB))).toBe(1);
      expect(countOf(await joinBatches(clientB))).toBe(1);
      // Operator: both visible.
      const allStock = await operator((tx) =>
        tx`select count(*)::int as n from stock_on_hand s
          join skus k on k.id = s.sku_id and k.tenant_id = s.tenant_id
          where s.tenant_id = ${tenantId}`,
      );
      expect(countOf(allStock)).toBe(2);
      const allBatches = await operator((tx) =>
        tx`select count(*)::int as n from batch_on_hand b
          join skus k on k.id = b.sku_id and k.tenant_id = b.tenant_id
          where b.tenant_id = ${tenantId}`,
      );
      expect(countOf(allBatches)).toBe(2);
    });

    it('the CLIENTS table: a portal session sees only its OWN client row; the operator sees all of the tenant’s', async () => {
      const a = await portal((tx) =>
        tx`select id, code from clients where tenant_id = ${tenantId}`,
      );
      expect(a).toHaveLength(1);
      expect((a[0] as unknown as { id: string }).id).toBe(clientA);

      const b = await portal(
        (tx) => tx`select id, code from clients where tenant_id = ${tenantId}`,
        clientB,
      );
      expect(b).toHaveLength(1);
      expect((b[0] as unknown as { id: string }).id).toBe(clientB);

      const all = await operator((tx) =>
        tx`select id, code from clients where tenant_id = ${tenantId} order by code`,
      );
      expect(all).toHaveLength(2);

      const unscoped = await probe.unsafe(
        `select id from clients where tenant_id = '${tenantId}'::uuid`,
      );
      expect(unscoped).toHaveLength(0);
    });

    it('the CLIENTS write arms: a portal session cannot mint another client (42501), but a session scoped to a NEW id can mint exactly that row', async () => {
      // Portal A inserting a row whose id is NOT its own client id → refused.
      const foreignInsert = portal((tx) =>
        tx`insert into clients (id, tenant_id, code, name, status, system_owned)
          values (${uuidv7()}, ${tenantId}, 'PROBE-FOREIGN', 'Foreign Client', 'active', false)`,
      );
      await expect(foreignInsert).rejects.toMatchObject({ code: '42501' });

      // The allow arm: a session stamped with a client id that does not exist
      // yet can mint exactly that row — the shape ensureSelfClientInTx runs
      // under once a portal session is the writer. (The operator path is
      // unchanged: the variable is unset, the tenant arm alone decides.)
      const freshId = uuidv7();
      await portal(
        (tx) =>
          tx`insert into clients (id, tenant_id, code, name, status, system_owned)
            values (${freshId}, ${tenantId}, 'PROBE-OWN', 'Probe Own', 'active', false)`,
        freshId,
      );
      await expectCount((t) => t`select count(*)::int as n from ${t('clients')} where id = ${freshId}`, 1);

      // …and that session STILL cannot mint the sibling's id.
      const wrongInsert = portal(
        (tx) =>
          tx`insert into clients (id, tenant_id, code, name, status, system_owned)
            values (${uuidv7()}, ${tenantId}, 'PROBE-WRONG', 'Probe Wrong', 'active', false)`,
        freshId,
      );
      await expect(wrongInsert).rejects.toMatchObject({ code: '42501' });

      await sql`delete from clients where id = ${freshId}`;
      await expectCount((t) => t`select count(*)::int as n from ${t('clients')} where id = ${freshId}`, 0);
    });

    it('the migration recreated the FIVE policies with the client clause (0060 and 0061 added the rate-card and storage-snapshot tables read-scoped, write operator-only), and lost none of the others', async () => {
      const policies = (await sql`
        select tablename, policyname, qual, with_check from pg_policies
        where schemaname = 'public' order by tablename, policyname
      `) as unknown as {
        tablename: string;
        policyname: string;
        qual: string | null;
        with_check: string | null;
      }[];
      // 0040 left 44 policies; 0041 recreated five; 0042 (story 4.6c) added
      // two — shipments and manifests; 0043 (story 5-1) added two more —
      // transfer_orders and transfer_order_lines; 0044 (story 5-2) added two
      // more — stock_adjustment_pendings and stock_adjustment_policies;
      // 0045 (story 5-3) added four more — count_policies, count_tasks,
      // count_task_lines and count_variances; 0046 (story 5-4) added one
      // more — count_variance_policies; 0047 (story 5-6) added one more —
      // rejected_ops; 0048 (story 6-1) added three more — reorder_policies,
      // reorder_breaches and suggested_pos; 0049 (story 6-2) added two more —
      // batch_alerts and expiry_alert_policies; 0050 (story 7-1) added three
      // more — integrations, channel_mappings and integration_calls; 0053
      // (story 8-1) added three more — invoices, invoice_lines and
      // invoice_series; 0056 (story 8-2b) added three more — eway_bills,
      // eway_state_thresholds and eway_gstin_settings; 0058 (story 9-1) added
      // two more — pack_verification_failures and ingest_backorder_refusals;
      // 0060 (story 21-3) added eight more — rate_cards and rate_card_lines,
      // each a client-scoped SELECT policy plus operator-only INSERT, UPDATE
      // and DELETE policies; 0061 (story 21-4) added eight more in the same
      // shape — storage_snapshots and storage_snapshot_progress; 0062 (story
      // 21-5) added nine more — client_invoices and client_invoice_lines in
      // the same four-policy shape (the invoice read clause also hides
      // drafts; the lines read clause inherits through the parent) and
      // client_invoice_series, one operator-only tenant policy; 0064 (story
      // 21-6) added two more — advance_shipment_notices (the purchase_orders
      // shape, both arms bound to the client) and asn_lines (both arms
      // inherit through the parent). None lost.
      expect(policies).toHaveLength(99);
      const asnPolicy = policies.find((row) => row.policyname === 'advance_shipment_notices_tenant_isolation')!;
      expect(asnPolicy.qual).toContain("(client_id = (NULLIF(current_setting('app.client_id'");
      expect(asnPolicy.with_check).toContain("(client_id = (NULLIF(current_setting('app.client_id'");
      const asnLinePolicy = policies.find((row) => row.policyname === 'asn_lines_tenant_isolation')!;
      expect(asnLinePolicy.qual).toContain('advance_shipment_notices');
      expect(asnLinePolicy.with_check).toContain('advance_shipment_notices');
      const invoiceRead = policies.find((row) => row.policyname === 'client_invoices_tenant_isolation')!;
      expect(invoiceRead.qual).toContain("(client_id = (NULLIF(current_setting('app.client_id'");
      expect(invoiceRead.qual).toContain("(status <> 'draft'::text)");
      const lineRead = policies.find((row) => row.policyname === 'client_invoice_lines_tenant_isolation')!;
      expect(lineRead.qual).toContain('client_invoices');
      for (const table of ['client_invoices', 'client_invoice_lines']) {
        expect(policies.filter((row) => row.tablename === table).map((row) => row.policyname).sort()).toEqual(
          [`${table}_operator_delete`, `${table}_operator_insert`, `${table}_operator_update`, `${table}_tenant_isolation`].sort(),
        );
      }
      const series = policies.filter((row) => row.tablename === 'client_invoice_series');
      expect(series.map((row) => row.policyname)).toEqual(['client_invoice_series_tenant_isolation']);
      expect(series[0]!.qual).toContain("(NULLIF(current_setting('app.client_id'::text, true), ''::text) IS NULL)");

      for (const table of READ_ONLY_CLIENT_TABLES) {
        const own = policies.filter((row) => row.tablename === table);
        expect(own.map((row) => row.policyname).sort()).toEqual(
          [`${table}_operator_delete`, `${table}_operator_insert`, `${table}_operator_update`, `${table}_tenant_isolation`].sort(),
        );
        const read = own.find((row) => row.policyname === `${table}_tenant_isolation`)!;
        expect(read.qual).toContain("(client_id = (NULLIF(current_setting('app.client_id'");
        expect(read.with_check).toBeNull();
        for (const write of own.filter((row) => row.policyname !== `${table}_tenant_isolation`)) {
          const arms = `${write.qual ?? ''} ${write.with_check ?? ''}`;
          // Operator-only: the client variable must be UNSET, and no arm binds a client.
          expect(arms).toContain("(NULLIF(current_setting('app.client_id'::text, true), ''::text) IS NULL)");
          expect(arms).not.toContain('(client_id =');
        }
      }

      for (const expected of CLIENT_POLICIES) {
        const found = policies.find(
          (row) => row.tablename === expected.table && row.policyname === expected.policy,
        );
        expect(found).toBeDefined();
        // Both arms carry the second fail-closed variable, and the binding
        // column is the one the policy is supposed to bind.
        expect(found!.qual).toContain('app.client_id');
        expect(found!.with_check).toContain('app.client_id');
        expect(found!.qual).toContain(expected.column);
        expect(found!.qual).toContain('app.tenant_id');

        if (expected.table === 'clients') {
          // The binding column here is `id`, and a substring check would be
          // vacuous ('id' is inside 'tenant_id' AND inside 'app.client_id') —
          // pin the FULL binding expression instead, in the form pg_get_expr
          // actually normalizes it to (verified against pg_policies):
          // `(id = (NULLIF(current_setting('app.client_id'::text, ...`.
          const clientsBinding = "(id = (NULLIF(current_setting('app.client_id'";
          expect(found!.qual).toContain(clientsBinding);
          expect(found!.with_check).toContain(clientsBinding);
        }
      }
    });
  });


  // ──────────────────────────────────────────────────────────────────────────
  // Part 3 — story 21-7: the PORTAL READ SHAPES, proved at the database.
  // The jest e2e suites connect as a superuser, so RLS never applies there
  // and test/portal.spec.ts proves only the app predicate. Here the portal
  // query shapes run as `wms_rls_probe`, client-stamped, with the explicit
  // `client_id = $client` predicate REMOVED — the RLS layer alone must
  // return only client A's rows (two layers, each proved on its own). The
  // inherited rows (stock, reservations, order / PO / invoice lines) reach
  // the client only through their stamped parent, exactly as the reads do.
  // ──────────────────────────────────────────────────────────────────────────
  describe('story 21-7: the portal read shapes isolate with RLS alone (no app predicate)', () => {
    let probe: postgres.Sql<Record<string, unknown>>;
    const lineIds = new Map<string, { orderLine: string; poLine: string }>();

    beforeAll(async () => {
      await ensureProbeRole();
      probe = postgres(probeUrl(), { max: 1 });
      // One order and one PO with a line per client, and a held order
      // reservation per client — below the API, like the rest of this suite.
      const vendorId = uuidv7();
      await sql`insert into vendors (id, tenant_id, code, name) values (${vendorId}, ${tenantId}, 'CI-V-21-7', 'Portal probe vendor')`;
      for (const [clientId, skuId] of [
        [clientA, skuAId],
        [clientB, skuBId],
      ] as const) {
        const orderId = uuidv7();
        const orderLine = uuidv7();
        await sql`insert into orders (id, tenant_id, client_id, warehouse_id, status, source)
          values (${orderId}, ${tenantId}, ${clientId}, ${warehouseId}, 'accepted', 'manual')`;
        await sql`insert into order_lines (id, tenant_id, order_id, sku_id, qty)
          values (${orderLine}, ${tenantId}, ${orderId}, ${skuId}, 2000)`;
        const poId = uuidv7();
        const poLine = uuidv7();
        await sql`insert into purchase_orders (id, tenant_id, client_id, warehouse_id, vendor_id, code, status)
          values (${poId}, ${tenantId}, ${clientId}, ${warehouseId}, ${vendorId}, ${'CI-PO-21-7-' + clientId.slice(-4)}, 'open')`;
        await sql`insert into purchase_order_lines (id, tenant_id, po_id, sku_id, ordered_qty, unit_cost_paise)
          values (${poLine}, ${tenantId}, ${poId}, ${skuId}, 3000, 100)`;
        await sql`insert into reservations (id, tenant_id, warehouse_id, sku_id, owner_type, owner_id, quantity, state, expires_at)
          values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${skuId}, 'order', ${orderId}, 1000, 'held', now() + interval '1 day')`;
        lineIds.set(clientId, { orderLine, poLine });
      }
    });

    afterAll(async () => {
      await probe?.end();
    });

    function stamped(
      run: (tx: postgres.TransactionSql<Record<string, unknown>>) => Promise<unknown>,
      client: string | null,
    ): Promise<unknown[]> {
      return probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        if (client !== null) await tx`select set_config('app.client_id', ${client}, true)`;
        return (await run(tx)) as unknown[];
      });
    }

    // The portal stock shape (`inventory/portal-stock.ts`) MINUS both
    // `s.client_id = $client` predicates.
    const stockShape = (tx: postgres.TransactionSql<Record<string, unknown>>) => tx`
      with oh as (
        select so.sku_id as sku, so.warehouse_id as wh, sum(so.quantity)::bigint as q
        from stock_on_hand so
        join skus s on s.tenant_id = so.tenant_id and s.id = so.sku_id
        where so.tenant_id = ${tenantId}
        group by so.sku_id, so.warehouse_id
      ),
      al as (
        select r.sku_id as sku, r.warehouse_id as wh, sum(r.quantity)::bigint as q
        from reservations r
        join skus s on s.tenant_id = r.tenant_id and s.id = r.sku_id
        where r.tenant_id = ${tenantId} and r.owner_type = 'order' and r.state in ('held', 'committed')
        group by r.sku_id, r.warehouse_id
      )
      select s.id as "skuId", coalesce(oh.q, 0)::bigint as "onHand", coalesce(al.q, 0)::bigint as "allocated"
      from oh
      full join al on al.sku = oh.sku and al.wh = oh.wh
      join skus s on s.tenant_id = ${tenantId} and s.id = coalesce(oh.sku, al.sku)
      join warehouses w on w.tenant_id = ${tenantId} and w.id = coalesce(oh.wh, al.wh)
      where (coalesce(oh.q, 0) > 0 or coalesce(al.q, 0) > 0)
      order by s.code asc, w.id asc`;

    // The portal order-line shape (`outbound/portal-orders.ts`) MINUS `o.client_id = $client`.
    const orderLineShape = (tx: postgres.TransactionSql<Record<string, unknown>>) => tx`
      select ol.id from order_lines ol
      join orders o on o.tenant_id = ol.tenant_id and o.id = ol.order_id
      left join skus s on s.tenant_id = ol.tenant_id and s.id = ol.sku_id
      where ol.tenant_id = ${tenantId}`;

    // The portal PO-line shape (`inbound/portal-inbound.ts`) MINUS `p.client_id = $client`.
    const poLineShape = (tx: postgres.TransactionSql<Record<string, unknown>>) => tx`
      select pl.id from purchase_order_lines pl
      join purchase_orders p on p.tenant_id = pl.tenant_id and p.id = pl.po_id
      left join skus s on s.tenant_id = pl.tenant_id and s.id = pl.sku_id
      where pl.tenant_id = ${tenantId}`;

    // The portal invoice shapes (`billing/portal-invoices.ts`) MINUS
    // `client_id = $client` AND `status <> 'draft'` — the policy alone must
    // hide the sibling's invoices and every draft.
    const invoiceShape = (tx: postgres.TransactionSql<Record<string, unknown>>) => tx`
      select id from client_invoices where tenant_id = ${tenantId}`;
    const invoiceLineShape = (tx: postgres.TransactionSql<Record<string, unknown>>) => tx`
      select i.id from client_invoice_lines l
      join client_invoices i on i.tenant_id = l.tenant_id and i.id = l.invoice_id
      where l.tenant_id = ${tenantId}`;

    // The header list shapes (orders / ASNs / POs) MINUS `client_id = $client`,
    // and the ASN-line shape MINUS `a.client_id = $client` — copies of the
    // portal SQL (the probe cannot drive the production functions: they run
    // on the app's connection, never as wms_rls_probe).
    const orderHeaderShape = (tx: postgres.TransactionSql<Record<string, unknown>>) => tx`
      select o.id,
             (select count(*)::int from order_lines ol
                where ol.tenant_id = o.tenant_id and ol.order_id = o.id and ol.parent_line_id is null) as "lineCount"
      from orders o
      join warehouses w on w.tenant_id = o.tenant_id and w.id = o.warehouse_id
      where o.tenant_id = ${tenantId}
      order by o.created_at desc, o.id desc`;
    const asnHeaderShape = (tx: postgres.TransactionSql<Record<string, unknown>>) => tx`
      select a.id, coalesce(t.line_count, 0)::int as "lineCount"
      from advance_shipment_notices a
      join warehouses w on w.tenant_id = a.tenant_id and w.id = a.warehouse_id
      left join lateral (
        select count(*) as line_count from asn_lines al where al.tenant_id = a.tenant_id and al.asn_id = a.id
      ) t on true
      where a.tenant_id = ${tenantId}
      order by a.created_at desc, a.id desc`;
    const asnLineShape = (tx: postgres.TransactionSql<Record<string, unknown>>) => tx`
      select al.asn_id as "asnId" from asn_lines al
      join advance_shipment_notices a on a.tenant_id = al.tenant_id and a.id = al.asn_id
      left join skus s on s.tenant_id = al.tenant_id and s.id = al.sku_id
      where al.tenant_id = ${tenantId}`;
    const poHeaderShape = (tx: postgres.TransactionSql<Record<string, unknown>>) => tx`
      select p.id from purchase_orders p
      join warehouses w on w.tenant_id = p.tenant_id and w.id = p.warehouse_id
      where p.tenant_id = ${tenantId}
      order by p.created_at desc, p.id desc`;

    async function idsOf(table: 'orders' | 'purchase_orders', clientId: string): Promise<string[]> {
      const rows = await sql`select id from ${sql(table)} where tenant_id = ${tenantId} and client_id = ${clientId}`;
      return rows.map((row) => row.id as string).sort();
    }

    it('order, ASN and PO header lists and ASN lines: client-stamped, only client A’s rows', async () => {
      const orders = ((await stamped(orderHeaderShape, clientA)) as { id: string }[]).map((row) => row.id).sort();
      expect(orders).toEqual(await idsOf('orders', clientA));
      expect(orders.length).toBeGreaterThan(0);
      const pos = ((await stamped(poHeaderShape, clientA)) as { id: string }[]).map((row) => row.id).sort();
      expect(pos).toEqual(await idsOf('purchase_orders', clientA));
      expect(pos.length).toBeGreaterThan(0);
      // (Earlier probe tests add lines to A's ASN — count them as the superuser.)
      const ownLines = Number((await sql`select count(*)::int as n from asn_lines where asn_id = ${asnIds.get(clientA)!}`)[0]!.n);
      const allLines = Number((await sql`select count(*)::int as n from asn_lines where tenant_id = ${tenantId}`)[0]!.n);
      expect(allLines).toBeGreaterThan(ownLines);
      const asns = (await stamped(asnHeaderShape, clientA)) as { id: string; lineCount: number }[];
      expect(asns).toEqual([{ id: asnIds.get(clientA)!, lineCount: ownLines }]);
      const asnLines = (await stamped(asnLineShape, clientA)) as { asnId: string }[];
      expect(asnLines.map((row) => row.asnId)).toEqual(Array.from({ length: ownLines }, () => asnIds.get(clientA)!));
      // Meaningful: unstamped, both clients' rows are there.
      const allOrders = ((await stamped(orderHeaderShape, null)) as unknown[]).length;
      expect(allOrders).toBe((await idsOf('orders', clientA)).length + (await idsOf('orders', clientB)).length);
      expect(((await stamped(poHeaderShape, null)) as unknown[]).length).toBe(
        (await idsOf('purchase_orders', clientA)).length + (await idsOf('purchase_orders', clientB)).length,
      );
      expect(((await stamped(asnHeaderShape, null)) as unknown[]).length).toBe(2);
      expect(((await stamped(asnLineShape, null)) as unknown[]).length).toBe(allLines);
    });

    it('stock: client-stamped, the shape returns ONLY client A’s SKU — the shared bin and B’s reservation never leak', async () => {
      const rows = (await stamped(stockShape, clientA)) as { skuId: string; onHand: string; allocated: string }[];
      expect(rows.map((row) => ({ skuId: row.skuId, onHand: Number(row.onHand), allocated: Number(row.allocated) }))).toEqual([
        { skuId: skuAId, onHand: 5000, allocated: 1000 },
      ]);
      // Meaningful: the operator shape (no client stamp) sees BOTH clients'
      // rows — the sibling's stock shares the same bin.
      const all = (await stamped(stockShape, null)) as { skuId: string }[];
      expect(new Set(all.map((row) => row.skuId))).toEqual(new Set([skuAId, skuBId]));
    });

    it('order lines and PO lines: reached only through the stamped parent, only client A’s', async () => {
      const own = lineIds.get(clientA)!;
      const orderLines = (await stamped(orderLineShape, clientA)) as { id: string }[];
      expect(orderLines.map((row) => row.id)).toEqual([own.orderLine]);
      const poLines = (await stamped(poLineShape, clientA)) as { id: string }[];
      expect(poLines.map((row) => row.id)).toEqual([own.poLine]);
      // Meaningful: unstamped, both clients' lines are there.
      expect(((await stamped(orderLineShape, null)) as unknown[]).length).toBe(2);
      expect(((await stamped(poLineShape, null)) as unknown[]).length).toBe(2);
    });

    it('invoices: client-stamped, only client A’s ISSUED invoice and its line — never B’s, never a draft', async () => {
      const own = invoiceIds.get(clientA)!;
      const invoices = (await stamped(invoiceShape, clientA)) as { id: string }[];
      expect(invoices.map((row) => row.id)).toEqual([own.issued]);
      const lines = (await stamped(invoiceLineShape, clientA)) as { id: string }[];
      expect(lines.map((row) => row.id)).toEqual([own.issued]);
      // Meaningful: unstamped, all four invoices (two clients × issued + draft).
      expect(((await stamped(invoiceShape, null)) as unknown[]).length).toBe(4);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Story 21-7b — the portal's first WRITE. `AsnCommand.announce` runs every
  // statement in a transaction stamped with the session's client; this runs
  // the WHOLE announce write set as `wms_rls_probe` under client A's stamp —
  // the header, a line, the idempotency key, the audit row and the outbox
  // message, plus the `portalAsnInTx` read-back (its SQL with the client
  // predicate removed) — and proves every statement is admitted, with a
  // positive control (the same header for client B is refused 42501 inside
  // the same transaction), then rolls it all back. A policy that refused one
  // of these tables to a stamped session would 500 every portal announce in
  // production while every superuser e2e test stayed green.
  // ──────────────────────────────────────────────────────────────────────────
  describe('story 21-7b: the announce write set and the portal/skus shape under a client stamp', () => {
    let probe: postgres.Sql<Record<string, unknown>>;
    const ROLLBACK = 'probe-rollback';
    let kitAId: string;

    beforeAll(async () => {
      await ensureProbeRole();
      probe = postgres(probeUrl(), { max: 1 });
      // A kit of client A (a composition row makes a SKU a kit) — the
      // portal/skus shape excludes it.
      kitAId = uuidv7();
      await sql`insert into skus (id, tenant_id, client_id, code, name, uom, gst_rate_bps, barcode)
        values (${kitAId}, ${tenantId}, ${clientA}, 'CI-KIT-A', 'Isolation kit A', 'each', 1800, ${ulid()})`;
      await sql`insert into kit_compositions (id, tenant_id, kit_sku_id, component_sku_id, qty)
        values (${uuidv7()}, ${tenantId}, ${kitAId}, ${skuAId}, 1000)`;
    });

    afterAll(async () => {
      await probe?.end();
    });

    it('every statement of the announce runs under client A’s stamp — header, line, key, audit, outbox, read-back — with a positive control, all rolled back', async () => {
      const asnId = uuidv7();
      const key = ulid();
      const seen: Record<string, unknown> = {};
      const run = probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        await tx`select set_config('app.client_id', ${clientA}, true)`;
        // The reads before the write: the warehouse, the client, A's SKUs.
        seen.warehouse = (await tx`select id from warehouses where tenant_id = ${tenantId} and id = ${warehouseId}`).length;
        seen.client = (await tx`select status from clients where tenant_id = ${tenantId} and id = ${clientA}`).map((row) => row.status);
        seen.skus = (await tx`select id from skus where tenant_id = ${tenantId} and id in (${skuAId}, ${skuBId})`).map((row) => row.id);
        // The write set.
        await tx`insert into advance_shipment_notices (id, tenant_id, client_id, warehouse_id, asn_code, status)
          values (${asnId}, ${tenantId}, ${clientA}, ${warehouseId}, 'CI-ASN-PORTAL', 'announced')`;
        await tx`insert into asn_lines (id, tenant_id, asn_id, sku_id, announced_qty, received_qty)
          values (${uuidv7()}, ${tenantId}, ${asnId}, ${skuAId}, 2500, 0)`;
        await tx`insert into outbox_messages (id, tenant_id, type, payload, occurred_at)
          values (${uuidv7()}, ${tenantId}, 'asn.created', ${tx.json({ asn: { id: asnId } })}, now())`;
        await tx`insert into audit_events (id, tenant_id, actor_user_id, action, target_type, target_id, reference, occurred_at)
          values (${uuidv7()}, ${tenantId}, ${uuidv7()}, 'asn.created', 'advance_shipment_notice', ${asnId}, ${key}, now())`;
        // The read-back (`portalAsnInTx`, header and lines) MINUS the client predicate.
        seen.header = await tx`
          select a.id, a.asn_code as "code", w.name as "warehouseName", coalesce(t.line_count, 0)::int as "lineCount"
          from advance_shipment_notices a
          join warehouses w on w.tenant_id = a.tenant_id and w.id = a.warehouse_id
          left join lateral (
            select count(*) as line_count from asn_lines al where al.tenant_id = a.tenant_id and al.asn_id = a.id
          ) t on true
          where a.tenant_id = ${tenantId} and a.id = ${asnId}`;
        seen.lines = await tx`
          select s.code as "skuCode", al.announced_qty::bigint as "announcedMilli"
          from asn_lines al
          join advance_shipment_notices a on a.tenant_id = al.tenant_id and a.id = al.asn_id
          left join skus s on s.tenant_id = al.tenant_id and s.id = al.sku_id
          where al.tenant_id = ${tenantId} and al.asn_id = ${asnId}`;
        // The idempotency key is LAST (the commit marker), as in the command.
        await tx`insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot)
          values (${uuidv7()}, ${tenantId}, ${key}, 'probe', ${tx.json({ id: asnId })})`;
        // Positive control: the same header for client B is refused by the
        // stamp (a savepoint keeps the transaction usable).
        seen.control = await tx
          .savepoint((sp) => sp`insert into advance_shipment_notices (id, tenant_id, client_id, warehouse_id, asn_code, status)
            values (${uuidv7()}, ${tenantId}, ${clientB}, ${warehouseId}, 'CI-ASN-PORTAL-B', 'announced')`)
          .then(
            () => 'admitted',
            (error: { code?: string }) => error.code,
          );
        throw new Error(ROLLBACK);
      });
      await expect(run).rejects.toThrow(ROLLBACK);

      expect(seen).toEqual({
        warehouse: 1,
        client: ['active'],
        skus: [skuAId],
        header: [{ id: asnId, code: 'CI-ASN-PORTAL', warehouseName: 'Isolation WH', lineCount: 1 }],
        lines: [{ skuCode: 'CI-SKU-A', announcedMilli: '2500' }],
        control: '42501',
      });
      // Rolled back: nothing of it remains.
      await expectCount((t) => t`select count(*)::int as n from ${t('advance_shipment_notices')} where id = ${asnId}`, 0);
      await expectCount((t) => t`select count(*)::int as n from ${t('asn_lines')} where asn_id = ${asnId}`, 0);
      await expectCount((t) => t`select count(*)::int as n from ${t('idempotency_keys')} where key = ${key}`, 0);
      await expectCount((t) => t`select count(*)::int as n from ${t('audit_events')} where target_id = ${asnId}`, 0);
      await expectCount((t) => t`select count(*)::int as n from ${t('outbox_messages')} where payload->'asn'->>'id' = ${asnId}`, 0);
    });

    // The portal/skus shape (`catalog/portal-skus.ts`) MINUS `s.client_id = $client`.
    const skuShape = (tx: postgres.TransactionSql<Record<string, unknown>>) => tx`
      select s.id from skus s
      where s.tenant_id = ${tenantId}
        and not exists (select 1 from kit_compositions k where k.tenant_id = s.tenant_id and k.kit_sku_id = s.id)
      order by s.code asc, s.id asc`;

    function stamped(client: string | null): Promise<string[]> {
      return probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        if (client !== null) await tx`select set_config('app.client_id', ${client}, true)`;
        return (await skuShape(tx)).map((row) => row.id as string);
      });
    }

    it('portal/skus: client-stamped, the shape returns ONLY client A’s non-kit SKUs', async () => {
      const ownNonKit = (
        await sql`select s.id from skus s where s.tenant_id = ${tenantId} and s.client_id = ${clientA}
          and not exists (select 1 from kit_compositions k where k.tenant_id = s.tenant_id and k.kit_sku_id = s.id)
          order by s.code asc, s.id asc`
      ).map((row) => row.id as string);
      expect(ownNonKit).toContain(skuAId);
      expect(ownNonKit).not.toContain(kitAId);
      const rows = await stamped(clientA);
      expect(rows).toEqual(ownNonKit);
      expect(rows).not.toContain(skuBId);
      // Meaningful: unstamped (the operator shape), B's SKU is there too.
      expect(await stamped(null)).toContain(skuBId);
    });
  });
});
