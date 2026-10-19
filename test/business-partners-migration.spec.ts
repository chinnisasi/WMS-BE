import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createDatabase } from '../src/shared/db/db';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';

jest.setTimeout(120_000);

const MIGRATION = '0079_business_partners.sql';

function migrationStatements(): string[] {
  return readFileSync(resolve(process.cwd(), 'drizzle', MIGRATION), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Story 1-3 — migration 0079 against a POPULATED database standing exactly
 * at 0078 (the repo's own migrations, journal trimmed — the
 * reporting-migration harness), applied whole inside one transaction as the
 * real runner applies it. Every other suite starts from a template already
 * migrated with no vendors in it, so this is the only place the rename, the
 * three backfills and the probe are proven against real rows. The four
 * acceptance assertions: every PO's vendor resolves to a partner with the
 * same id; every historical (vendor, client) pair has an active link; every
 * PO carries a full v1 snapshot; each client has at most one default.
 */
describe('migration 0079: the business partner master', () => {
  const PRE_DB = 'wms_s_partners_premigration';
  let sql: ReturnType<typeof postgres>;
  let folder: string;

  const tenantId = uuidv7();
  const warehouseId = uuidv7();
  const c1 = uuidv7(); // the self client
  const c2 = uuidv7(); // a brand
  const c3 = uuidv7(); // a brand with no history
  const v1 = uuidv7(); // default, created FIRST — POs for c1
  const v2 = uuidv7(); // default, created second — POs for c1, an open draft for c2's SKU
  const v3 = uuidv7(); // not default — a PO for c1, only a DISMISSED draft for c2
  const v4 = uuidv7(); // default, no history at all
  const sku1 = uuidv7(); // c1's
  const sku2 = uuidv7(); // c2's
  const poIds: string[] = [];

  beforeAll(async () => {
    const baseUrl = process.env.DATABASE_URL!;
    const url = new URL(baseUrl);
    url.pathname = `/${PRE_DB}`;
    const preUrl = url.toString();
    const adminUrl = new URL(baseUrl);
    adminUrl.pathname = '/postgres';
    const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => undefined });
    try {
      await admin.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PRE_DB}'`);
      await admin.unsafe(`drop database if exists "${PRE_DB}"`);
      await admin.unsafe(`create database "${PRE_DB}"`);
    } finally {
      await admin.end();
    }

    folder = mkdtempSync(join(tmpdir(), 'wms-pre-0079-'));
    cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
    rmSync(join(folder, MIGRATION));
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 78);
    writeFileSync(journalPath, JSON.stringify(journal));
    const db = createDatabase(preUrl);
    await migrate(db, { migrationsFolder: folder });
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();

    sql = postgres(preUrl, { max: 2, onnotice: () => undefined });
    expect(await sql`select to_regclass('public.business_partners') as t`).toEqual([{ t: null }]);

    // ── the "before" state, through the 0078 schema ─────────────────────────
    await sql`insert into clients (id, tenant_id, code, name, status, system_owned) values
      (${c1}, ${tenantId}, 'self', 'Migration Co', 'active', true),
      (${c2}, ${tenantId}, 'BRAND-2', 'Brand Two', 'active', false),
      (${c3}, ${tenantId}, 'BRAND-3', 'Brand Three', 'active', false)`;
    await sql`insert into skus (id, tenant_id, client_id, code, name, uom, gst_rate_bps, barcode) values
      (${sku1}, ${tenantId}, ${c1}, 'M-1', 'Item one', 'each', 1800, ${ulid()}),
      (${sku2}, ${tenantId}, ${c2}, 'M-2', 'Item two', 'each', 1800, ${ulid()})`;
    await sql`insert into vendors (id, tenant_id, code, name, is_default, created_at) values
      (${v1}, ${tenantId}, 'V-1', 'Vendor One', true, '2026-01-01T00:00:00Z'),
      (${v2}, ${tenantId}, 'V-2', 'Vendor Two', true, '2026-01-02T00:00:00Z'),
      (${v3}, ${tenantId}, 'V-3', 'Vendor Three', false, '2026-01-03T00:00:00Z'),
      (${v4}, ${tenantId}, 'V-4', 'Vendor Four', true, '2025-12-31T00:00:00Z')`;
    const po = async (vendorId: string, clientId: string, code: string): Promise<void> => {
      const id = uuidv7();
      poIds.push(id);
      await sql`insert into purchase_orders (id, tenant_id, client_id, warehouse_id, vendor_id, code, status)
        values (${id}, ${tenantId}, ${clientId}, ${warehouseId}, ${vendorId}, ${code}, 'open')`;
    };
    await po(v1, c1, 'PO-1');
    await po(v1, c1, 'PO-1B');
    await po(v2, c1, 'PO-2');
    await po(v3, c1, 'PO-3');
    const draft = async (vendorId: string | null, skuId: string, status: string): Promise<void> => {
      await sql`insert into suggested_pos (id, tenant_id, warehouse_id, sku_id, breach_id, vendor_id, quantity_milli, status)
        values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${skuId}, ${uuidv7()}, ${vendorId}, 1000, ${status})`;
    };
    await draft(v2, sku2, 'draft');
    await draft(v3, sku2, 'dismissed');
    await draft(null, sku1, 'draft');
  });

  afterAll(async () => {
    await sql?.end();
    rmSync(folder, { recursive: true, force: true });
    const adminUrl = new URL(process.env.DATABASE_URL!);
    adminUrl.pathname = '/postgres';
    const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => undefined });
    try {
      await admin.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PRE_DB}'`);
      await admin.unsafe(`drop database if exists "${PRE_DB}"`);
    } finally {
      await admin.end();
    }
  });

  it('aborts naming the PO when a vendor_id resolves to nothing — and rolls back whole', async () => {
    const orphan = uuidv7();
    await sql`insert into purchase_orders (id, tenant_id, client_id, warehouse_id, vendor_id, code, status)
      values (${orphan}, ${tenantId}, ${c1}, ${warehouseId}, ${uuidv7()}, 'PO-ORPHAN', 'open')`;
    try {
      await expect(
        sql.begin(async (tx) => {
          for (const statement of migrationStatements()) await tx.unsafe(statement);
        }),
      ).rejects.toThrow(/PO-ORPHAN/);
      expect(await sql`select to_regclass('public.business_partners') as t`).toEqual([{ t: null }]);
    } finally {
      await sql`delete from purchase_orders where id = ${orphan}`;
    }
  });

  describe('applied to the populated database', () => {
    beforeAll(async () => {
      await sql.begin(async (tx) => {
        for (const statement of migrationStatements()) await tx.unsafe(statement);
      });
    });

    it('renames in place: every PO\'s vendor_id resolves to a partner with the same id; created_at kept; vendors is gone', async () => {
      expect(await sql`select to_regclass('public.vendors') as t`).toEqual([{ t: null }]);
      const unresolved = await sql`
        select po.code from purchase_orders po
        where not exists (select 1 from business_partners bp where bp.tenant_id = po.tenant_id and bp.id = po.vendor_id)`;
      expect(unresolved).toEqual([]);
      const partners = (await sql`
        select id, code, roles, status, inactive_reason, created_at from business_partners where tenant_id = ${tenantId} order by code`) as unknown as {
        id: string;
        code: string;
        roles: string[];
        status: string;
        inactive_reason: string | null;
        created_at: Date;
      }[];
      expect(partners.map((p) => [p.id, p.code])).toEqual([
        [v1, 'V-1'],
        [v2, 'V-2'],
        [v3, 'V-3'],
        [v4, 'V-4'],
      ]);
      for (const partner of partners) expect(partner).toMatchObject({ roles: ['vendor'], status: 'active', inactive_reason: null });
      expect(new Date(partners[0]!.created_at).toISOString()).toBe('2026-01-01T00:00:00.000Z');
      const column = await sql`select 1 from information_schema.columns where table_name = 'business_partners' and column_name = 'is_default'`;
      expect(column).toEqual([]);
    });

    it('links from history: every PO pair and every OPEN draft pair is an active vendor link; a dismissed draft and a vendor with no history are not linked', async () => {
      const links = (await sql`
        select partner_id, client_id, role, active, client_code from partner_client_links where tenant_id = ${tenantId}
        order by partner_id, client_id`) as unknown as { partner_id: string; client_id: string; role: string; active: boolean; client_code: string | null }[];
      const pairs = links.map((l) => `${l.partner_id}:${l.client_id}`).sort();
      expect(pairs).toEqual([`${v1}:${c1}`, `${v2}:${c1}`, `${v2}:${c2}`, `${v3}:${c1}`].sort());
      for (const row of links) expect(row).toMatchObject({ role: 'vendor', active: true, client_code: null });
      const missing = await sql`
        select po.code from purchase_orders po where not exists (
          select 1 from partner_client_links l
          where l.tenant_id = po.tenant_id and l.partner_id = po.vendor_id and l.client_id = po.client_id and l.role = 'vendor' and l.active)`;
      expect(missing).toEqual([]);
    });

    it('the default moved onto the link: per client the linked is_default vendor with the lowest (created_at, id); at most one per client; none where nothing is linked', async () => {
      const defaults = (await sql`
        select client_id, partner_id from partner_client_links where tenant_id = ${tenantId} and is_default order by client_id`) as unknown as {
        client_id: string;
        partner_id: string;
      }[];
      // c1: V-1 and V-2 are both linked defaults → V-1 (earlier). V-4 is older
      // but has no history, so it is linked nowhere and defaults nowhere
      // (decision 10). c2: only V-2. c3: none.
      expect(Object.fromEntries(defaults.map((d) => [d.client_id, d.partner_id]))).toEqual({ [c1]: v1, [c2]: v2 });
      const perClient = await sql`select client_id from partner_client_links where is_default group by client_id having count(*) > 1`;
      expect(perClient).toEqual([]);
    });

    it('every PO carries the full v1 vendor snapshot, every key present', async () => {
      const rows = (await sql`select code, vendor_snapshot from purchase_orders where tenant_id = ${tenantId} order by code`) as unknown as {
        code: string;
        vendor_snapshot: Record<string, unknown>;
      }[];
      expect(rows).toHaveLength(poIds.length);
      const name: Record<string, [string, string]> = {
        'PO-1': ['V-1', 'Vendor One'],
        'PO-1B': ['V-1', 'Vendor One'],
        'PO-2': ['V-2', 'Vendor Two'],
        'PO-3': ['V-3', 'Vendor Three'],
      };
      for (const row of rows) {
        expect(row.vendor_snapshot).toEqual({
          v: 1,
          code: name[row.code]![0],
          name: name[row.code]![1],
          legalName: null,
          gstin: null,
          stateCode: null,
          registeredAddress: null,
          dispatchAddress: null,
        });
      }
    });

    it('the renamed policy and the new client-scoped link policy are in place; RLS on both', async () => {
      const policies = (await sql`
        select tablename, policyname, qual from pg_policies where tablename in ('business_partners', 'partner_client_links') order by tablename`) as unknown as {
        tablename: string;
        policyname: string;
        qual: string;
      }[];
      expect(policies.map((p) => p.policyname)).toEqual(['business_partners_tenant_isolation', 'partner_client_links_tenant_isolation']);
      expect(policies[1]!.qual).toContain("current_setting('app.client_id'");
      const rls = (await sql`
        select relname, relrowsecurity from pg_class where relname in ('business_partners', 'partner_client_links') order by relname`) as unknown as {
        relname: string;
        relrowsecurity: boolean;
      }[];
      expect(rls.every((r) => r.relrowsecurity)).toBe(true);
    });

    it('refuses to run twice', async () => {
      await expect(
        sql.begin(async (tx) => {
          for (const statement of migrationStatements()) await tx.unsafe(statement);
        }),
      ).rejects.toThrow(/already been applied/);
    });
  });
});
