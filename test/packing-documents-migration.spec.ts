import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { uuidv7 } from '../src/shared/primitives/ids';
import { createDatabase } from '../src/shared/db/db';
import { EMAIL_ATTACHMENT_KINDS } from '../src/modules/mail/mail-rules';
import { ORDER_PACK_SOURCES, ORDER_PACK_STATUSES } from '../src/modules/outbound/cartons';
import { cartonCode } from '../src/shared/primitives/carton-code';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';

jest.setTimeout(180_000);

const MIGRATION = '0117_packing_documents.sql';

function migrationStatements(): string[] {
  return readFileSync(resolve(process.cwd(), 'drizzle', MIGRATION), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Story 4-5a (A5) — migration 0117 against a database standing exactly at
 * 0116 (the repo's own migrations, journal trimmed — the 0112 harness),
 * carrying a mail row of each existing attachment kind, applied whole inside
 * one transaction as the real runner applies it: its own probes run (a probe
 * that failed would abort the apply), the CHECKs are validated and pinned
 * against the TS tuples, the old mail rows survive the widened CHECKs, a
 * re-run fails fast, and the RLS client clause holds as `wms_rls_probe`.
 */
describe('migration 0117: packing documents', () => {
  const PRE_DB = 'wms_s_packing_documents_premigration';
  let sql: ReturnType<typeof postgres>;
  let folder: string;
  let preUrl: string;

  const tenantId = uuidv7();
  const acme = uuidv7();
  const beta = uuidv7();
  const warehouseId = uuidv7();

  async function applyInOneTransaction(): Promise<void> {
    await sql.begin(async (tx) => {
      for (const statement of migrationStatements()) await tx.unsafe(statement);
    });
  }

  beforeAll(async () => {
    const baseUrl = process.env.DATABASE_URL!;
    const url = new URL(baseUrl);
    url.pathname = `/${PRE_DB}`;
    preUrl = url.toString();
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
    folder = mkdtempSync(join(tmpdir(), 'wms-pre-0117-'));
    cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
    rmSync(join(folder, MIGRATION));
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 116);
    writeFileSync(journalPath, JSON.stringify(journal));
    const db = createDatabase(preUrl);
    await migrate(db, { migrationsFolder: folder });
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
    sql = postgres(preUrl, { max: 2, onnotice: () => undefined });
    expect(await sql`select count(*)::int as n from information_schema.tables where table_name = 'order_packs'`).toEqual([{ n: 0 }]);

    // ── the "before" state: a mail row of each attachment kind 0116 knows ─
    await sql`insert into email_messages (id, tenant_id, template, to_email, params, status, next_attempt_at, client_id, dedupe_key, priority, attachment_kind, attachment_ref)
      values (${uuidv7()}, ${tenantId}, 'client-receipt', 'a@example.in', '{}', 'sent', now(), ${acme}, 'client-receipt:g1:a@example.in', 1, 'grn-pdf', ${uuidv7()}),
             (${uuidv7()}, ${tenantId}, 'client-shipment-document', 'a@example.in', '{}', 'sent', now(), ${acme}, 'client-shipment-document:a1:a@example.in', 1, 'stored-file', ${uuidv7()}),
             (${uuidv7()}, ${tenantId}, 'client-dispatch', 'a@example.in', '{}', 'sent', now(), ${acme}, 'client-dispatch:o1:a@example.in', 1, null, null)`;
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

  it('applies over existing mail: the three tables, every CHECK validated and pinned against the TS tuples, the old mail rows kept; a re-run fails fast', async () => {
    await applyInOneTransaction();
    expect(
      await sql`select table_name from information_schema.tables where table_name in ('order_packs', 'order_cartons', 'order_carton_lines') order by table_name`,
    ).toEqual([{ table_name: 'order_carton_lines' }, { table_name: 'order_cartons' }, { table_name: 'order_packs' }]);
    const checks = (await sql`select conname, pg_get_constraintdef(oid) as def, convalidated from pg_constraint
      where conrelid in ('public.order_packs'::regclass, 'public.order_cartons'::regclass, 'public.order_carton_lines'::regclass, 'public.email_messages'::regclass)
        and contype = 'c'`) as unknown as { conname: string; def: string; convalidated: boolean }[];
    const def = (name: string) => {
      const found = checks.find((check) => check.conname === name);
      if (found === undefined) throw new Error(`missing CHECK ${name}`);
      return found;
    };
    const literals = (name: string) => [...def(name).def.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
    expect(literals('order_packs_status_check')).toEqual([...ORDER_PACK_STATUSES]);
    expect(literals('order_packs_source_check')).toEqual([...ORDER_PACK_SOURCES]);
    expect(literals('email_messages_attachment_kind_check')).toEqual([...EMAIL_ATTACHMENT_KINDS]);
    expect(literals('email_messages_attachment_template_check')).toEqual([
      'grn-pdf',
      'client-receipt',
      'stored-file',
      'client-shipment-document',
      'packing-slip-pdf',
      'client-dispatch',
    ]);
    // Every constraint name later migrations drop by name (D1).
    const names = checks.map((check) => check.conname).filter((name) => name.startsWith('order_')).sort();
    expect(names).toEqual(
      [
        'order_carton_lines_handling_units_shape',
        'order_carton_lines_qty_positive',
        'order_cartons_code_derived',
        'order_cartons_code_shape',
        'order_cartons_dims',
        'order_cartons_handover_pairing',
        'order_cartons_line_count_range',
        'order_cartons_pack_seq_range',
        'order_cartons_seq_range',
        'order_cartons_units_positive',
        'order_cartons_weight_range',
        'order_packs_carton_count_range',
        'order_packs_device_pairing',
        'order_packs_end_pairing',
        'order_packs_end_reason',
        'order_packs_gross_weight_range',
        'order_packs_parties_shape',
        'order_packs_seq_range',
        'order_packs_source_check',
        'order_packs_status_check',
      ].sort(),
    );
    // The tables are new and empty: every CHECK is validated.
    expect(checks.filter((check) => !check.convalidated && (check.conname.startsWith('order_') || check.conname.startsWith('email_messages_attachment')))).toEqual([]);
    // The probes left nothing behind, and the old mail rows survived the widened CHECKs.
    expect(await sql`select count(*)::int as n from order_packs`).toEqual([{ n: 0 }]);
    expect(await sql`select count(*)::int as n from order_cartons`).toEqual([{ n: 0 }]);
    expect(await sql`select count(*)::int as n from order_carton_lines`).toEqual([{ n: 0 }]);
    expect(await sql`select attachment_kind from email_messages where tenant_id = ${tenantId} order by attachment_kind nulls last`).toEqual([
      { attachment_kind: 'grn-pdf' },
      { attachment_kind: 'stored-file' },
      { attachment_kind: null },
    ]);
    const indexes = (await sql`select indexname from pg_indexes where indexname in ('order_packs_live_unique', 'order_packs_tenant_order_seq_unique', 'order_cartons_tenant_code_unique', 'order_cartons_tenant_pack_seq_unique', 'order_cartons_tenant_order_pack_seq_idx', 'order_carton_lines_carton_sku_unique', 'order_carton_lines_tenant_order_idx')`) as unknown as { indexname: string }[];
    expect(indexes).toHaveLength(7);
    await expect(applyInOneTransaction()).rejects.toThrow(/already been applied/);
  });

  it('the code CHECK agrees with cartonCode, and refuses a code naming another pack (outside the probe)', async () => {
    const orderId = uuidv7();
    const packId = uuidv7();
    const row = (code: string, seq: number) => sql`insert into order_cartons (id, tenant_id, warehouse_id, client_id, order_id, pack_id, pack_seq, seq, code, unit_count, line_count)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${acme}, ${orderId}, ${packId}, 1, ${seq}, ${code}, 1000, 1)`;
    await row(cartonCode(orderId, 1, 12), 12);
    await expect(row(cartonCode(orderId, 2, 1), 1)).rejects.toThrow(/order_cartons_code_derived/);
    await sql`delete from order_cartons where order_id = ${orderId}`;
  });

  it('RLS (A1–A3): a client-stamped wms_rls_probe sees only its client’s packs, cartons and lines; the operator shape sees the tenant’s', async () => {
    const orderA = uuidv7();
    const orderB = uuidv7();
    const packA = uuidv7();
    const packB = uuidv7();
    const parties = sql.json({ v: 1, client: { name: 'Brand' }, warehouse: { code: 'WH1', name: 'Main' } });
    for (const [orderId, packId, clientId] of [
      [orderA, packA, acme],
      [orderB, packB, beta],
    ] as const) {
      await sql`insert into order_packs (id, tenant_id, warehouse_id, client_id, order_id, seq, status, carton_count, document_parties, parties_frozen_at, source, packed_by, packed_at)
        values (${packId}, ${tenantId}, ${warehouseId}, ${clientId}, ${orderId}, 1, 'live', 1, ${parties}, now(), 'web', ${uuidv7()}, now())`;
      const cartonId = uuidv7();
      await sql`insert into order_cartons (id, tenant_id, warehouse_id, client_id, order_id, pack_id, pack_seq, seq, code, unit_count, line_count)
        values (${cartonId}, ${tenantId}, ${warehouseId}, ${clientId}, ${orderId}, ${packId}, 1, 1, ${cartonCode(orderId, 1, 1)}, 1000, 1)`;
      await sql`insert into order_carton_lines (id, tenant_id, client_id, order_id, carton_id, sku_id, qty)
        values (${uuidv7()}, ${tenantId}, ${clientId}, ${orderId}, ${cartonId}, ${uuidv7()}, 1000)`;
    }
    await sql.unsafe(`do $$ begin
      if not exists (select from pg_roles where rolname = 'wms_rls_probe') then
        create role wms_rls_probe login password 'wms_rls_probe' nosuperuser;
      end if;
    end $$;`);
    await sql.unsafe('grant usage on schema public to wms_rls_probe');
    await sql.unsafe('grant select on order_packs, order_cartons, order_carton_lines to wms_rls_probe');
    const probeUrl = new URL(preUrl);
    probeUrl.username = 'wms_rls_probe';
    probeUrl.password = 'wms_rls_probe';
    const probe = postgres(probeUrl.toString(), { max: 1, onnotice: () => undefined });
    try {
      const read = (clientId: string | null) =>
        probe.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
          if (clientId !== null) await tx`select set_config('app.client_id', ${clientId}, true)`;
          const ids = async (table: 'order_packs' | 'order_cartons' | 'order_carton_lines') =>
            ((await tx.unsafe(`select order_id from ${table}`)) as unknown as { order_id: string }[]).map((r) => r.order_id).sort();
          return { packs: await ids('order_packs'), cartons: await ids('order_cartons'), lines: await ids('order_carton_lines') };
        });
      expect(await read(acme)).toEqual({ packs: [orderA], cartons: [orderA], lines: [orderA] });
      expect(await read(beta)).toEqual({ packs: [orderB], cartons: [orderB], lines: [orderB] });
      // Positive control: the operator shape (no client stamp) sees both.
      const both = [orderA, orderB].sort();
      expect(await read(null)).toEqual({ packs: both, cartons: both, lines: both });
    } finally {
      await probe.end();
    }
  });
});
