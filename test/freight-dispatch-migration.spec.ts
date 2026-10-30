import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { uuidv7 } from '../src/shared/primitives/ids';
import { createDatabase } from '../src/shared/db/db';
import { CLIENT_EMAIL_TEMPLATES, EMAIL_TEMPLATES } from '../src/modules/mail/mail-rules';
import { CLIENT_EMAIL_EVENTS } from '../src/modules/clients/clients.schema';
import { ATTACHMENT_OWNER_TYPES, ATTACHMENT_PURPOSES, SHIPPING_DOC_KINDS } from '../src/modules/attachments/attachment-records';
import { WEBHOOK_EVENT_TYPES } from '../src/modules/client-webhooks/webhook-rules';
import { CONSIGNMENT_GATE_CODES } from '../src/shared/primitives/consignment-gate';
import { DELIVERY_OUTCOMES, FREIGHT_MODES, FREIGHT_TERMS, PACKAGE_TYPES, VEHICLE_TYPES } from '../src/shared/primitives/freight';
import {
  FREIGHT_CONSIGNMENT_STATUSES,
  FREIGHT_LOAD_EXCEPTIONS,
  FREIGHT_LOAD_STATUSES,
  FREIGHT_SCAN_STATUSES,
} from '../src/modules/outbound/freight-vocabulary';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';

jest.setTimeout(180_000);

const MIGRATION = '0119_freight_dispatch.sql';

function migrationStatements(): string[] {
  return readFileSync(resolve(process.cwd(), 'drizzle', MIGRATION), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Story 4-9a (A7, A35, D1, D2) — migration 0119 against a database standing
 * exactly at 0118 (the repo's own migrations, journal trimmed — the 0112
 * harness), carrying a packed carton, mail rows, a contact and webhook rows,
 * applied whole inside one transaction as the real runner applies it: its own
 * probes run (a probe that failed would abort the apply); the CHECKs are
 * pinned against the TS tuples; exactly the six NOT VALID CHECKs are not
 * validated (D2: no VALIDATE under the ADD's lock) and every other one is;
 * existing rows keep their bytes and the carton reads the default type; a
 * re-run fails fast; the staff-only RLS holds as `wms_rls_probe` (A35).
 */
describe('migration 0119: freight dispatch', () => {
  const PRE_DB = 'wms_s_freight_premigration';
  let sql: ReturnType<typeof postgres>;
  let folder: string;
  let preUrl: string;

  const tenantId = uuidv7();
  const acme = uuidv7();
  const beta = uuidv7();
  const warehouseId = uuidv7();
  const userId = uuidv7();
  const orderId = uuidv7();

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
    folder = mkdtempSync(join(tmpdir(), 'wms-pre-0119-'));
    cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
    rmSync(join(folder, MIGRATION));
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number; when: number }[] };
    // The journal's `when` is later than every prior entry (guide §3 — the deploy migrator's rule).
    const own = journal.entries.find((entry) => entry.idx === 119)!;
    expect(journal.entries.filter((entry) => entry.idx < 119).every((entry) => entry.when < own.when)).toBe(true);
    journal.entries = journal.entries.filter((entry) => entry.idx <= 118);
    writeFileSync(journalPath, JSON.stringify(journal));
    const db = createDatabase(preUrl);
    await migrate(db, { migrationsFolder: folder });
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
    sql = postgres(preUrl, { max: 2, onnotice: () => undefined });
    expect(await sql`select count(*)::int as n from information_schema.tables where table_name = 'freight_loads'`).toEqual([{ n: 0 }]);

    // ── the "before" state ────────────────────────────────────────────────
    const code = `O${orderId.replace(/-/g, '').slice(-16).toUpperCase()}.1.1`;
    await sql`insert into order_cartons (id, tenant_id, warehouse_id, client_id, order_id, pack_id, pack_seq, seq, code, weight_grams, unit_count, line_count)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${acme}, ${orderId}, ${uuidv7()}, 1, 1, ${code}, 1000000, 10000, 1)`;
    await sql`insert into email_messages (id, tenant_id, template, to_email, params, status, next_attempt_at, client_id, dedupe_key, priority)
      values (${uuidv7()}, ${tenantId}, 'client-documents-needed', 'a@example.in', '{}', 'sent', now(), ${acme}, 'client-documents-needed:o1:a@example.in', 1),
             (${uuidv7()}, ${tenantId}, 'user-invite', 'u@example.in', '{}', 'sent', now(), null, null, 0)`;
    await sql`insert into client_contacts (id, tenant_id, client_id, name, email, roles, email_events) values (${uuidv7()}, ${tenantId}, ${acme}, 'Asha', 'asha@acme.example', '{}', ARRAY['order.dispatched', 'consignment.documents-needed'])`;
    await sql`insert into webhook_events (id, tenant_id, client_id, event_type, subject_id, body) values (${uuidv7()}, ${tenantId}, ${acme}, 'order.dispatched', ${orderId}, '{}')`;
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

  it('applies over existing rows: every CHECK pinned against its TS tuple; only the six NOT VALID ones unvalidated (D2); existing rows kept; the default package type; a re-run fails fast', async () => {
    await applyInOneTransaction();
    const checks = (await sql`select conname, pg_get_constraintdef(oid) as def, convalidated from pg_constraint
      where conrelid in ('public.freight_loads'::regclass, 'public.freight_consignments'::regclass, 'public.freight_load_scans'::regclass,
                         'public.order_cartons'::regclass, 'public.attachments'::regclass, 'public.email_messages'::regclass,
                         'public.client_contacts'::regclass, 'public.webhook_endpoints'::regclass, 'public.webhook_events'::regclass)
        and contype = 'c'`) as unknown as { conname: string; def: string; convalidated: boolean }[];
    const def = (name: string) => {
      const found = checks.find((check) => check.conname === name);
      if (found === undefined) throw new Error(`missing CHECK ${name}`);
      return found;
    };
    const literals = (name: string) => [...def(name).def.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
    expect(literals('freight_loads_status_check')).toEqual([...FREIGHT_LOAD_STATUSES]);
    expect(literals('freight_loads_mode_check')).toEqual([...FREIGHT_MODES]);
    expect(literals('freight_loads_vehicle_type_check')).toEqual([...VEHICLE_TYPES]);
    expect(literals('freight_consignments_status_check')).toEqual([...FREIGHT_CONSIGNMENT_STATUSES]);
    expect(literals('freight_consignments_freight_terms_check')).toEqual([...FREIGHT_TERMS]);
    expect(literals('freight_consignments_load_exception_check')).toEqual([...FREIGHT_LOAD_EXCEPTIONS, 'dispatched']);
    expect(literals('freight_consignments_compliance_exception_check')).toEqual([...CONSIGNMENT_GATE_CODES, 'dispatched']);
    expect(literals('freight_consignments_delivery_outcome_check')).toEqual(expect.arrayContaining([...DELIVERY_OUTCOMES]));
    expect(literals('freight_load_scans_status_check')).toEqual([...FREIGHT_SCAN_STATUSES]);
    expect(literals('order_cartons_package_type_check')).toEqual([...PACKAGE_TYPES]);
    expect(literals('attachments_purpose_check')).toEqual([...ATTACHMENT_PURPOSES]);
    expect(literals('attachments_owner_type_check')).toEqual([...ATTACHMENT_OWNER_TYPES]);
    expect(literals('attachments_doc_kind_check')).toEqual(['shipping-document', ...SHIPPING_DOC_KINDS]);
    expect(literals('email_messages_template_check')).toEqual([...EMAIL_TEMPLATES]);
    expect(literals('email_messages_client_shape_check')).toEqual([...CLIENT_EMAIL_TEMPLATES, ...CLIENT_EMAIL_TEMPLATES]);
    const events = /ARRAY\[([^\]]+)\]/.exec(def('client_contacts_email_events_check').def)![1]!;
    expect([...events.matchAll(/'([a-z.-]+)'::text/g)].map((m) => m[1]!)).toEqual([...CLIENT_EMAIL_EVENTS]);
    const hookTypes = /ARRAY\[([^\]]+)\]/.exec(def('webhook_endpoints_event_types_check').def)![1]!;
    expect([...hookTypes.matchAll(/'([a-z.-]+)'::text/g)].map((m) => m[1]!)).toEqual([...WEBHOOK_EVENT_TYPES]);
    expect(literals('webhook_events_type_check')).toEqual([...WEBHOOK_EVENT_TYPES]);
    // D1 — every name 0120 (4-10a) drops or reads by name, kept exactly.
    for (const name of [
      'attachments_purpose_check',
      'attachments_owner_type_check',
      'attachments_purpose_owner',
      'attachments_doc_kind_check',
      'email_messages_template_check',
      'email_messages_client_shape_check',
      'client_contacts_email_events_check',
      'webhook_endpoints_event_types_check',
      'webhook_events_type_check',
      'order_cartons_weight_range',
    ]) {
      def(name);
    }
    // D2 — exactly the six NOT VALID CHECKs are unvalidated (their VALIDATE is DEPLOY §5).
    expect(checks.filter((check) => !check.convalidated).map((check) => check.conname).sort()).toEqual(
      [
        'email_messages_client_shape_check',
        'email_messages_template_check',
        'order_cartons_inner_count',
        'order_cartons_package_type_check',
        'order_cartons_weight_range',
        'webhook_events_type_check',
      ].sort(),
    );
    // The existing rows survived; the carton reads the default type; the probes left nothing.
    expect(await sql`select package_type, inner_count, weight_grams from order_cartons where tenant_id = ${tenantId}`).toEqual([
      { package_type: 'carton', inner_count: null, weight_grams: 1000000 },
    ]);
    expect(await sql`select count(*)::int as n from email_messages where tenant_id = ${tenantId}`).toEqual([{ n: 2 }]);
    expect(await sql`select count(*)::int as n from webhook_events where tenant_id = ${tenantId}`).toEqual([{ n: 1 }]);
    for (const table of ['freight_loads', 'freight_consignments', 'freight_load_scans']) {
      expect(await sql.unsafe(`select count(*)::int as n from ${table}`)).toEqual([{ n: 0 }]);
    }
    const indexes = (await sql`select indexname from pg_indexes where tablename in ('freight_loads', 'freight_consignments', 'freight_load_scans') and indexname not like '%_pkey'`) as unknown as { indexname: string }[];
    expect(indexes.map((row) => row.indexname).sort()).toEqual(
      [
        'freight_consignments_client_dispatched_idx',
        'freight_consignments_client_live_idx',
        'freight_consignments_delivery_exceptions_idx',
        'freight_consignments_lr_idx',
        'freight_consignments_order_live_unique',
        'freight_consignments_pod_pending_idx',
        'freight_consignments_tenant_load_stop_idx',
        'freight_load_scans_loaded_unique',
        'freight_load_scans_tenant_consignment_status_idx',
        'freight_loads_open_idx',
        'freight_loads_tenant_code_unique',
        'freight_loads_tenant_warehouse_created_idx',
      ].sort(),
    );
    const policies = (await sql`select tablename, policyname from pg_policies where tablename in ('freight_loads', 'freight_consignments', 'freight_load_scans') order by tablename`) as unknown as { tablename: string; policyname: string }[];
    expect(policies).toEqual([
      { tablename: 'freight_consignments', policyname: 'freight_consignments_tenant_isolation' },
      { tablename: 'freight_load_scans', policyname: 'freight_load_scans_staff_only' },
      { tablename: 'freight_loads', policyname: 'freight_loads_staff_only' },
    ]);
    await expect(applyInOneTransaction()).rejects.toThrow(/already been applied/);
  });

  it('a pallet weighs up to 3,000 kg, a carton still 1,000 kg, an inner count is a pallet’s (the NOT VALID CHECKs bind new rows)', async () => {
    const insert = (overrides: Record<string, unknown>) => {
      const order = uuidv7();
      return sql`insert into order_cartons ${sql({
        id: uuidv7(),
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        client_id: acme,
        order_id: order,
        pack_id: uuidv7(),
        pack_seq: 1,
        seq: 1,
        code: `O${order.replace(/-/g, '').slice(-16).toUpperCase()}.1.1`,
        unit_count: 1000,
        line_count: 1,
        ...overrides,
      } as Record<string, postgres.ParameterOrJSON<never>>)}`;
    };
    await insert({ package_type: 'pallet', weight_grams: 3_000_000, inner_count: 600 });
    await expect(insert({ package_type: 'pallet', weight_grams: 3_000_001 })).rejects.toThrow(/order_cartons_weight_range/);
    await expect(insert({ weight_grams: 1_200_000 })).rejects.toThrow(/order_cartons_weight_range/);
    await expect(insert({ inner_count: 4 })).rejects.toThrow(/order_cartons_inner_count/);
  });

  it('RLS (A35): under a client stamp freight_loads and freight_load_scans return no row and refuse an insert; the tenant stamp reads and writes them; freight_consignments returns only the client’s rows', async () => {
    const loadId = uuidv7();
    const consA = uuidv7();
    const consB = uuidv7();
    const loadRow = (id: string) => ({
      id,
      tenant_id: tenantId,
      warehouse_id: warehouseId,
      code: `LD-${String(Math.floor(Math.random() * 90000) + 10000)}`,
      status: 'open',
      mode: 'ltl',
      transporter_name: 'VRL',
      created_by: userId,
    });
    const scanRow = (consignmentId: string) => ({
      id: uuidv7(),
      tenant_id: tenantId,
      load_id: loadId,
      consignment_id: consignmentId,
      order_id: orderId,
      package_code: 'O0123456789ABCDEF.1.1',
      pack_seq: 1,
      package_seq: 1,
      status: 'loaded',
      scanned_at: new Date().toISOString(),
      scanned_by: userId,
      source: 'web',
    });
    const consRow = (id: string, clientId: string) => ({
      id,
      tenant_id: tenantId,
      warehouse_id: warehouseId,
      load_id: loadId,
      order_id: uuidv7(),
      client_id: clientId,
      status: 'planned',
      stop_seq: 1,
      added_by: userId,
    });
    await sql`insert into freight_loads ${sql(loadRow(loadId) as Record<string, postgres.ParameterOrJSON<never>>)}`;
    await sql`insert into freight_consignments ${sql(consRow(consA, acme) as Record<string, postgres.ParameterOrJSON<never>>)}`;
    await sql`insert into freight_consignments ${sql(consRow(consB, beta) as Record<string, postgres.ParameterOrJSON<never>>)}`;
    await sql`insert into freight_load_scans ${sql(scanRow(consA) as Record<string, postgres.ParameterOrJSON<never>>)}`;
    await sql.unsafe(`do $$ begin
      if not exists (select from pg_roles where rolname = 'wms_rls_probe') then
        create role wms_rls_probe login password 'wms_rls_probe' nosuperuser;
      end if;
    end $$;`);
    await sql.unsafe('grant usage on schema public to wms_rls_probe');
    await sql.unsafe('grant select, insert, update on freight_loads, freight_consignments, freight_load_scans to wms_rls_probe');
    const probeUrl = new URL(preUrl);
    probeUrl.username = 'wms_rls_probe';
    probeUrl.password = 'wms_rls_probe';
    const probe = postgres(probeUrl.toString(), { max: 1, onnotice: () => undefined });
    const stamped = async <T>(clientId: string | null, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
      (await probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        if (clientId !== null) await tx`select set_config('app.client_id', ${clientId}, true)`;
        return fn(tx);
      })) as T;
    try {
      const count = (table: string) => async (tx: postgres.TransactionSql) =>
        ((await tx.unsafe(`select count(*)::int as n from ${table}`)) as unknown as { n: number }[])[0]!.n;
      // The positive control: the tenant (staff) stamp sees every row.
      expect(await stamped(null, count('freight_loads'))).toBe(1);
      expect(await stamped(null, count('freight_load_scans'))).toBe(1);
      expect(await stamped(null, count('freight_consignments'))).toBe(2);
      // A client stamp sees no load and no scan — not even its own consignment's.
      expect(await stamped(acme, count('freight_loads'))).toBe(0);
      expect(await stamped(acme, count('freight_load_scans'))).toBe(0);
      const own = async (tx: postgres.TransactionSql) =>
        ((await tx`select id from freight_consignments`) as unknown as { id: string }[]).map((row) => row.id);
      expect(await stamped(acme, own)).toEqual([consA]);
      expect(await stamped(beta, own)).toEqual([consB]);
      // WITH CHECK: a client stamp writes no load and no scan; the staff stamp does.
      await expect(stamped(acme, (tx) => tx`insert into freight_loads ${tx(loadRow(uuidv7()) as Record<string, postgres.ParameterOrJSON<never>>)}`)).rejects.toThrow(/row-level security/);
      await expect(stamped(acme, (tx) => tx`insert into freight_load_scans ${tx(scanRow(consB) as Record<string, postgres.ParameterOrJSON<never>>)}`)).rejects.toThrow(/row-level security/);
      await stamped(null, (tx) => tx`insert into freight_load_scans ${tx(scanRow(consB) as Record<string, postgres.ParameterOrJSON<never>>)}`);
      const touched = await stamped(acme, (tx) => tx`update freight_loads set note = 'x' where id = ${loadId}`);
      expect(touched.count).toBe(0);
    } finally {
      await probe.end();
    }
  });
});
