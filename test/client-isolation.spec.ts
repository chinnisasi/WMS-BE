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
];

/** The five policies migration 0041 recreated with the client clause. */
const CLIENT_POLICIES: readonly { table: string; policy: string; column: string }[] = [
  { table: 'skus', policy: 'skus_tenant_isolation', column: 'client_id' },
  { table: 'ledger_events', policy: 'ledger_events_tenant_isolation', column: 'client_id' },
  { table: 'purchase_orders', policy: 'purchase_orders_tenant_isolation', column: 'client_id' },
  { table: 'orders', policy: 'orders_tenant_isolation', column: 'client_id' },
  { table: 'clients', policy: 'clients_tenant_isolation', column: 'id' },
];

describe('story 21-2: client isolation RLS — app.client_id, the stamping primitive, the DB probe', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // The fixtures: ONE tenant, TWO clients (the system-owned `self` client and
  // a second non-self client seeded by direct SQL — no client CRUD API
  // exists), and rows for BOTH clients in every probed table. A single-client
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
    await sql`insert into clients (id, tenant_id, code, name, status, system_owned)
      values (${clientB}, ${tenantId}, 'brand-b', 'Brand B', 'active', false)`;

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

    it('a PORTAL-shaped session sees its own rows and ZERO of the sibling client’s, on all four stamped tables', async () => {
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

    it('the WITH CHECK arm rejects a foreign-client INSERT with 42501, on all four stamped tables', async () => {
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
          values (${uuidv7()}, ${tenantId}, 'probe-foreign', 'Foreign Client', 'active', false)`,
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
            values (${freshId}, ${tenantId}, 'probe-own', 'Probe Own', 'active', false)`,
        freshId,
      );
      await expectCount((t) => t`select count(*)::int as n from ${t('clients')} where id = ${freshId}`, 1);

      // …and that session STILL cannot mint the sibling's id.
      const wrongInsert = portal(
        (tx) =>
          tx`insert into clients (id, tenant_id, code, name, status, system_owned)
            values (${uuidv7()}, ${tenantId}, 'probe-wrong', 'Probe Wrong', 'active', false)`,
        freshId,
      );
      await expect(wrongInsert).rejects.toMatchObject({ code: '42501' });

      await sql`delete from clients where id = ${freshId}`;
      await expectCount((t) => t`select count(*)::int as n from ${t('clients')} where id = ${freshId}`, 0);
    });

    it('the migration recreated the FIVE policies with the client clause, and lost none of the other 39', async () => {
      const policies = (await sql`
        select tablename, policyname, qual, with_check from pg_policies
        where schemaname = 'public' order by tablename, policyname
      `) as unknown as {
        tablename: string;
        policyname: string;
        qual: string;
        with_check: string;
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
      // batch_alerts and expiry_alert_policies. None lost.
      expect(policies).toHaveLength(61);

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
});
