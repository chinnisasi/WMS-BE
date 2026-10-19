import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { uuidv7 } from '../src/shared/primitives/ids';
import { createDatabase } from '../src/shared/db/db';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';

jest.setTimeout(120_000);

const MIGRATION = '0080_sku_master.sql';

function migrationStatements(): string[] {
  return readFileSync(resolve(process.cwd(), 'drizzle', MIGRATION), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Story 1-4 — migration 0080 against a POPULATED database standing exactly at
 * 0079 (the repo's own migrations, journal trimmed — the 0079 harness),
 * applied whole inside one transaction as the real runner applies it. The
 * acceptance assertions: every SKU has exactly one primary `sku_barcodes` row
 * equal to `skus.barcode`; every product carries its SKUs' client (or the
 * self client when it has none); each pre-flight aborts listing EVERY
 * offender and rolls back whole; every new CHECK refuses its bad shape.
 */
describe('migration 0080: the SKU master', () => {
  const PRE_DB = 'wms_s_sku_master_premigration';
  let sql: ReturnType<typeof postgres>;
  let folder: string;

  const tenantId = uuidv7();
  const selfClient = uuidv7();
  const brand = uuidv7();
  const skuSelf = uuidv7();
  const skuBrand = uuidv7();
  const skuBrand2 = uuidv7();
  const productBrand = uuidv7(); // its SKUs are the brand's
  const productEmpty = uuidv7(); // no SKUs → self

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

    folder = mkdtempSync(join(tmpdir(), 'wms-pre-0080-'));
    cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
    rmSync(join(folder, MIGRATION));
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 79);
    writeFileSync(journalPath, JSON.stringify(journal));
    const db = createDatabase(preUrl);
    await migrate(db, { migrationsFolder: folder });
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();

    sql = postgres(preUrl, { max: 2, onnotice: () => undefined });
    expect(await sql`select to_regclass('public.sku_barcodes') as t`).toEqual([{ t: null }]);

    // ── the "before" state, through the 0079 schema ─────────────────────────
    await sql`insert into clients (id, tenant_id, code, name, status, system_owned) values
      (${selfClient}, ${tenantId}, 'self', 'Migration Co', 'active', true),
      (${brand}, ${tenantId}, 'BRAND-1', 'Brand One', 'active', false)`;
    await sql`insert into products (id, tenant_id, name, axes) values
      (${productBrand}, ${tenantId}, 'Tee', ${sql.json(['size'])}),
      (${productEmpty}, ${tenantId}, 'Empty', ${sql.json(['size'])})`;
    await sql`insert into skus (id, tenant_id, client_id, code, name, uom, gst_rate_bps, barcode, product_id, variant_values) values
      (${skuSelf}, ${tenantId}, ${selfClient}, 'S-1', 'Self one', 'each', 1800, 'GTIN-SELF-1', null, null),
      (${skuBrand}, ${tenantId}, ${brand}, 'B-1', 'Brand tee S', 'kg', 1800, '8901000000001', ${productBrand}, ${sql.json({ size: 'S' })}),
      (${skuBrand2}, ${tenantId}, ${brand}, 'B-2', 'Brand tee M', 'each', 1800, 'GTIN-SELF-1', ${productBrand}, ${sql.json({ size: 'M' })})`;
    await sql`insert into uom_conversions (id, tenant_id, sku_id, uom, factor) values
      (${uuidv7()}, ${tenantId}, ${skuSelf}, 'case', 12)`;
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

  async function applyMigration(): Promise<void> {
    await sql.begin(async (tx) => {
      for (const statement of migrationStatements()) await tx.unsafe(statement);
    });
  }

  it('aborts listing EVERY offender at once (barcode rule, factor range, a product spanning clients) — and rolls back whole', async () => {
    const badBarcodeSku = uuidv7();
    const badFactorSku = uuidv7();
    const spanning = uuidv7();
    await sql`insert into skus (id, tenant_id, client_id, code, name, uom, gst_rate_bps, barcode) values
      (${badBarcodeSku}, ${tenantId}, ${selfClient}, 'BAD-BC', 'Bad barcode', 'each', 0, 'has;semicolon'),
      (${badFactorSku}, ${tenantId}, ${selfClient}, 'BAD-F', 'Bad factor', 'each', 0, 'OK-BC-F')`;
    await sql`insert into uom_conversions (id, tenant_id, sku_id, uom, factor) values (${uuidv7()}, ${tenantId}, ${badFactorSku}, 'box', 1)`;
    await sql`insert into products (id, tenant_id, name, axes) values (${spanning}, ${tenantId}, 'Spanning', ${sql.json(['size'])})`;
    const spanA = uuidv7();
    const spanB = uuidv7();
    await sql`insert into skus (id, tenant_id, client_id, code, name, uom, gst_rate_bps, barcode, product_id, variant_values) values
      (${spanA}, ${tenantId}, ${selfClient}, 'SPAN-A', 'Span A', 'each', 0, 'SPAN-A-BC', ${spanning}, ${sql.json({ size: 'A' })}),
      (${spanB}, ${tenantId}, ${brand}, 'SPAN-B', 'Span B', 'each', 0, 'SPAN-B-BC', ${spanning}, ${sql.json({ size: 'B' })})`;
    try {
      let message = '';
      try {
        await applyMigration();
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('BAD-BC');
      expect(message).toContain('has;semicolon');
      expect(message).toContain('BAD-F');
      expect(message).toContain("'Spanning'");
      // Rolled back whole: nothing of 0080 exists.
      expect(await sql`select to_regclass('public.sku_barcodes') as t`).toEqual([{ t: null }]);
      expect(
        await sql`select count(*)::int as n from information_schema.columns where table_name = 'products' and column_name = 'client_id'`,
      ).toEqual([{ n: 0 }]);
    } finally {
      await sql`delete from uom_conversions where sku_id = ${badFactorSku}`;
      await sql`delete from skus where id in (${badBarcodeSku}, ${badFactorSku}, ${spanA}, ${spanB})`;
      await sql`delete from products where id = ${spanning}`;
    }
  });

  it('a leading space, a non-ASCII character or a factor over a million is an offender too', async () => {
    const sp = uuidv7();
    const na = uuidv7();
    await sql`insert into skus (id, tenant_id, client_id, code, name, uom, gst_rate_bps, barcode) values
      (${sp}, ${tenantId}, ${selfClient}, 'LEAD-SP', 'n', 'each', 0, ' 890'),
      (${na}, ${tenantId}, ${selfClient}, 'NON-ASCII', 'n', 'each', 0, ${'café'})`;
    await sql`insert into uom_conversions (id, tenant_id, sku_id, uom, factor) values (${uuidv7()}, ${tenantId}, ${sp}, 'pallet', 1000001)`;
    try {
      let message = '';
      try {
        await applyMigration();
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('LEAD-SP');
      expect(message).toContain('NON-ASCII');
      expect(message).toContain('pallet × 1000001');
    } finally {
      await sql`delete from uom_conversions where sku_id = ${sp}`;
      await sql`delete from skus where id in (${sp}, ${na})`;
    }
  });

  describe('applied to the clean "before" state', () => {
    beforeAll(async () => {
      await applyMigration();
    });

    it('every SKU has exactly one primary barcode row, equal to skus.barcode at its base uom and client', async () => {
      const rows = (await sql`
        select s.code, b.barcode, b.uom, b.client_id, b.is_primary, s.barcode as sku_barcode, s.uom as sku_uom, s.client_id as sku_client
        from skus s join sku_barcodes b on b.sku_id = s.id
        where s.tenant_id = ${tenantId} order by s.code
      `) as unknown as { code: string; barcode: string; uom: string; client_id: string; is_primary: boolean; sku_barcode: string; sku_uom: string; sku_client: string }[];
      expect(rows.map((row) => [row.code, row.barcode, row.uom, row.is_primary])).toEqual([
        ['B-1', '8901000000001', 'kg', true],
        ['B-2', 'GTIN-SELF-1', 'each', true],
        ['S-1', 'GTIN-SELF-1', 'each', true],
      ]);
      for (const row of rows) {
        expect(row.barcode).toBe(row.sku_barcode);
        expect(row.uom).toBe(row.sku_uom);
        expect(row.client_id).toBe(row.sku_client);
      }
    });

    it("each product carries its SKUs' client; a product with none takes the self client; client_id is NOT NULL", async () => {
      const rows = (await sql`select id, client_id from products where tenant_id = ${tenantId}`) as unknown as {
        id: string;
        client_id: string;
      }[];
      const byId = new Map(rows.map((row) => [row.id, row.client_id]));
      expect(byId.get(productBrand)).toBe(brand);
      expect(byId.get(productEmpty)).toBe(selfClient);
      const nullable = await sql`select is_nullable from information_schema.columns where table_name = 'products' and column_name = 'client_id'`;
      expect(nullable).toEqual([{ is_nullable: 'NO' }]);
    });

    it('product names are unique per (tenant, client): the old tenant-wide index is gone', async () => {
      const indexes = (await sql`select indexname from pg_indexes where tablename = 'products' order by indexname`) as unknown as {
        indexname: string;
      }[];
      const names = indexes.map((row) => row.indexname);
      expect(names).toContain('products_tenant_client_name_unique');
      expect(names).not.toContain('products_tenant_id_name_unique');
      // The same name in two clients is admitted…
      await sql`insert into products (id, tenant_id, client_id, name, axes) values (${uuidv7()}, ${tenantId}, ${selfClient}, 'Tee', ${sql.json(['size'])})`;
      // …and twice in one client is refused.
      await expect(
        sql`insert into products (id, tenant_id, client_id, name, axes) values (${uuidv7()}, ${tenantId}, ${brand}, 'Tee', ${sql.json(['size'])})`,
      ).rejects.toMatchObject({ code: '23505', constraint_name: 'products_tenant_client_name_unique' });
    });

    it('refuses a second run (fail-fast)', async () => {
      await expect(applyMigration()).rejects.toThrow(/already been applied/);
    });

    it('every new CHECK refuses its bad shape and admits a good one', async () => {
      const refuse = async (statement: Promise<unknown>, constraint: string): Promise<void> => {
        await expect(statement).rejects.toMatchObject({ constraint_name: constraint });
      };
      await refuse(sql`update skus set shelf_life_days = 0 where id = ${skuSelf}`, 'skus_shelf_life_days_check');
      await refuse(sql`update skus set shelf_life_days = 3651 where id = ${skuSelf}`, 'skus_shelf_life_days_check');
      await sql`update skus set shelf_life_days = 3650 where id = ${skuSelf}`;
      await sql`update skus set shelf_life_days = null where id = ${skuSelf}`;
      await refuse(sql`update uom_conversions set factor = 1 where sku_id = ${skuSelf}`, 'uom_conversions_factor_check');
      await refuse(sql`update uom_conversions set factor = 1000001 where sku_id = ${skuSelf}`, 'uom_conversions_factor_check');
      await sql`update uom_conversions set factor = 1000000 where sku_id = ${skuSelf}`;
      const insertBarcode = (barcode: string, uom = 'each') =>
        sql`insert into sku_barcodes (id, tenant_id, client_id, sku_id, barcode, uom) values (${uuidv7()}, ${tenantId}, ${selfClient}, ${skuSelf}, ${barcode}, ${uom})`;
      for (const bad of ['', ' 890', '890 ', '890;1', 'café', 'a\tb', '9'.repeat(65)]) {
        await refuse(insertBarcode(bad), 'sku_barcodes_barcode_check');
      }
      await refuse(insertBarcode('UNIQUE-OK-1', 'cases'), 'sku_barcodes_uom_check');
      await insertBarcode('A B~!', 'case');
      await refuse(insertBarcode('A B~!', 'case'), 'sku_barcodes_tenant_client_barcode_unique');
      await refuse(
        sql`insert into sku_barcodes (id, tenant_id, client_id, sku_id, barcode, uom, is_primary) values (${uuidv7()}, ${tenantId}, ${selfClient}, ${skuSelf}, 'SECOND-PRIMARY', 'each', true)`,
        'sku_barcodes_primary_unique',
      );
    });

    it('sku_barcodes and products carry the tenant + app.client_id RLS clause', async () => {
      const rows = (await sql`
        select tablename, qual, with_check from pg_policies where tablename in ('sku_barcodes', 'products') order by tablename
      `) as unknown as { tablename: string; qual: string; with_check: string }[];
      expect(rows.map((row) => row.tablename)).toEqual(['products', 'sku_barcodes']);
      for (const row of rows) {
        expect(row.qual).toContain('app.client_id');
        expect(row.with_check).toContain('app.client_id');
        expect(row.qual).toContain('(client_id = (NULLIF(current_setting(\'app.client_id\'');
      }
    });
  });
});
