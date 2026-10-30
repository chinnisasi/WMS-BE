import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { uuidv7 } from '../src/shared/primitives/ids';
import { createDatabase } from '../src/shared/db/db';
import { CLIENT_EMAIL_TEMPLATES, EMAIL_TEMPLATES } from '../src/modules/mail/mail-rules';
import { CLIENT_EMAIL_EVENTS, CONSIGNMENT_DOCUMENT_RULES } from '../src/modules/clients/clients.schema';
import {
  CONSIGNMENT_EWAY_STATUSES,
  CONSIGNMENT_RECORD_SOURCES,
  CONSIGNMENT_RECORD_STATUSES,
  EWAY_EXEMPTION_REASONS,
  ORDER_BRAND_DOCUMENT_TYPES,
} from '../src/shared/primitives/consignment-record';
import { CONSIGNMENT_GATE_CODES } from '../src/shared/primitives/consignment-gate';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';

jest.setTimeout(180_000);

const MIGRATION = '0118_consignment_compliance.sql';

function migrationStatements(): string[] {
  return readFileSync(resolve(process.cwd(), 'drizzle', MIGRATION), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Story 4-6a (A7, D1, D2) — migration 0118 against a database standing
 * exactly at 0117 (the repo's own migrations, journal trimmed — the 0112
 * harness), carrying a client, a handed-over shipment, an RTV, mail rows and
 * a contact, applied whole inside one transaction as the real runner applies
 * it: its own probes run (a probe that failed would abort the apply); the
 * CHECKs are pinned against the TS tuples; the three NOT VALID CHECKs are
 * not validated (D2: no VALIDATE under the ADD's lock) and every other one
 * is; existing rows keep their bytes and the client reads the default rule;
 * a re-run fails fast; the trigger refuses a rewrite; RLS holds as
 * `wms_rls_probe`, for reads and for the portal write set.
 */
describe('migration 0118: consignment compliance', () => {
  const PRE_DB = 'wms_s_consignment_premigration';
  let sql: ReturnType<typeof postgres>;
  let folder: string;
  let preUrl: string;

  const tenantId = uuidv7();
  const acme = uuidv7();
  const beta = uuidv7();
  const warehouseId = uuidv7();
  const userId = uuidv7();

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
    folder = mkdtempSync(join(tmpdir(), 'wms-pre-0118-'));
    cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
    rmSync(join(folder, MIGRATION));
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number; when: number }[] };
    // The journal's `when` is later than every prior entry (guide §3 — the deploy migrator's rule).
    const own = journal.entries.find((entry) => entry.idx === 118)!;
    expect(journal.entries.filter((entry) => entry.idx < 118).every((entry) => entry.when < own.when)).toBe(true);
    journal.entries = journal.entries.filter((entry) => entry.idx <= 117);
    writeFileSync(journalPath, JSON.stringify(journal));
    const db = createDatabase(preUrl);
    await migrate(db, { migrationsFolder: folder });
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
    sql = postgres(preUrl, { max: 2, onnotice: () => undefined });
    expect(await sql`select count(*)::int as n from information_schema.tables where table_name = 'order_consignment_records'`).toEqual([{ n: 0 }]);

    // ── the "before" state ────────────────────────────────────────────────
    await sql`insert into clients (id, tenant_id, code, name, status, system_owned) values (${acme}, ${tenantId}, 'ACME', 'Acme', 'active', false), (${beta}, ${tenantId}, 'BETA', 'Beta', 'active', false)`;
    await sql`insert into shipments (id, tenant_id, warehouse_id, order_id, client_id, status, kind, carrier_name, tracking_number, label_attachment_id, package_count, labelled_by, labelled_at, recorded_surface, handover_id, handed_over_at, label_verified_at, label_verified_by, label_verify_method)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${uuidv7()}, ${acme}, 'handed_over', 'client-label', 'Delhivery', 'AWB0117', ${uuidv7()}, 1, ${userId}, now(), 'portal', ${uuidv7()}, now(), now(), ${userId}, 'handover-scan')`;
    await sql`insert into email_messages (id, tenant_id, template, to_email, params, status, next_attempt_at, client_id, dedupe_key, priority)
      values (${uuidv7()}, ${tenantId}, 'client-dispatch', 'a@example.in', '{}', 'sent', now(), ${acme}, 'client-dispatch:o1:a@example.in', 1),
             (${uuidv7()}, ${tenantId}, 'user-invite', 'u@example.in', '{}', 'sent', now(), null, null, 0)`;
    await sql`insert into client_contacts (id, tenant_id, client_id, name, email, roles, email_events) values (${uuidv7()}, ${tenantId}, ${acme}, 'Asha', 'asha@acme.example', '{}', ARRAY['order.dispatched', 'shipment.documents'])`;
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

  it('applies over existing rows: every CHECK pinned against its TS tuple; only the three NOT VALID ones unvalidated (D2); existing rows kept; the default rule; a re-run fails fast', async () => {
    await applyInOneTransaction();
    const checks = (await sql`select conname, pg_get_constraintdef(oid) as def, convalidated from pg_constraint
      where conrelid in ('public.order_consignment_records'::regclass, 'public.clients'::regclass, 'public.shipments'::regclass,
                         'public.vendor_returns'::regclass, 'public.email_messages'::regclass, 'public.client_contacts'::regclass)
        and contype = 'c'`) as unknown as { conname: string; def: string; convalidated: boolean }[];
    const def = (name: string) => {
      const found = checks.find((check) => check.conname === name);
      if (found === undefined) throw new Error(`missing CHECK ${name}`);
      return found;
    };
    const literals = (name: string) => [...def(name).def.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
    const T = 'order_consignment_records';
    expect(literals(`${T}_status_check`)).toEqual([...CONSIGNMENT_RECORD_STATUSES]);
    expect(literals(`${T}_source_check`)).toEqual([...CONSIGNMENT_RECORD_SOURCES]);
    expect(literals(`${T}_brand_document_type_check`)).toEqual([...ORDER_BRAND_DOCUMENT_TYPES]);
    expect(literals(`${T}_eway_status_check`)).toEqual([...CONSIGNMENT_EWAY_STATUSES]);
    expect(literals(`${T}_eway_exempt_pairing`)).toEqual(expect.arrayContaining(['exempt', ...EWAY_EXEMPTION_REASONS]));
    expect(literals('clients_consignment_document_rule_check')).toEqual([...CONSIGNMENT_DOCUMENT_RULES]);
    expect(literals('shipments_compliance_exception_check')).toEqual([...CONSIGNMENT_GATE_CODES]);
    // 0118's sets: 4-9a's 0119 appends `client-delivery-update` and `delivery.recorded` (pinned by freight-dispatch-migration.spec.ts).
    expect(literals('email_messages_template_check')).toEqual(EMAIL_TEMPLATES.filter((template) => template !== 'client-delivery-update'));
    // The client-shape CHECK lists the client templates twice (both arms, D9).
    const clientTemplates0118 = CLIENT_EMAIL_TEMPLATES.filter((template) => template !== 'client-delivery-update');
    expect(literals('email_messages_client_shape_check')).toEqual([...clientTemplates0118, ...clientTemplates0118]);
    const events = /ARRAY\[([^\]]+)\]/.exec(def('client_contacts_email_events_check').def)![1]!;
    expect([...events.matchAll(/'([a-z.-]+)'::text/g)].map((m) => m[1]!)).toEqual(CLIENT_EMAIL_EVENTS.filter((event) => event !== 'delivery.recorded'));
    // D1 — every name later migrations drop or read by name.
    expect(
      checks
        .map((check) => check.conname)
        .filter((name) => name.startsWith(T))
        .sort(),
    ).toEqual(
      [
        'brand_document_number_length',
        'brand_document_type_check',
        'consignor_gstin_shape',
        'consignor_snapshot_shape',
        'declared_value_range',
        'destination_pairing',
        'end_pairing',
        'eway_dates',
        'eway_exempt_pairing',
        'eway_number_shape',
        'eway_recorded_pairing',
        'eway_required_derived',
        'eway_status_by_requirement',
        'eway_status_check',
        'eway_validity_required',
        'seq_range',
        'source_check',
        'status_check',
        'supply_type_check',
        'threshold_rule_shape',
      ].map((suffix) => `${T}_${suffix}`),
    );
    // D2 — exactly the three NOT VALID CHECKs are unvalidated (VALIDATE is DEPLOY §5).
    const touched = checks.filter(
      (check) =>
        check.conname.startsWith(T) ||
        [
          'clients_consignment_document_rule_check',
          'shipments_compliance_exception_check',
          'vendor_returns_declared_value_range',
          'email_messages_template_check',
          'email_messages_client_shape_check',
          'client_contacts_email_events_check',
        ].includes(check.conname),
    );
    expect(touched.filter((check) => !check.convalidated).map((check) => check.conname).sort()).toEqual(
      ['email_messages_client_shape_check', 'email_messages_template_check', 'shipments_compliance_exception_check'].sort(),
    );
    // The existing rows survived; the clients read the default rule; the probes left nothing.
    expect(await sql`select code, consignment_document_rule from clients where tenant_id = ${tenantId} order by code`).toEqual([
      { code: 'ACME', consignment_document_rule: 'b2b' },
      { code: 'BETA', consignment_document_rule: 'b2b' },
    ]);
    expect(await sql`select compliance_exception from shipments where tenant_id = ${tenantId}`).toEqual([{ compliance_exception: null }]);
    expect(await sql`select count(*)::int as n from email_messages where tenant_id = ${tenantId}`).toEqual([{ n: 2 }]);
    expect(await sql`select count(*)::int as n from order_consignment_records`).toEqual([{ n: 0 }]);
    const indexes = (await sql`select indexname from pg_indexes where indexname in (
      'order_consignment_records_tenant_order_seq_unique', 'order_consignment_records_live_unique',
      'order_consignment_records_client_eway_live_unique', 'order_consignment_records_client_document_idx', 'shipments_compliance_exception_idx')`) as unknown as { indexname: string }[];
    expect(indexes).toHaveLength(5);
    // The trigger is enabled after the probes disabled nothing.
    expect(await sql`select tgenabled from pg_trigger where tgname = 'order_consignment_records_immutable'`).toEqual([{ tgenabled: 'O' }]);
    await expect(applyInOneTransaction()).rejects.toThrow(/already been applied/);
  });

  function recordRow(clientId: string, orderId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: uuidv7(),
      tenant_id: tenantId,
      client_id: clientId,
      warehouse_id: warehouseId,
      order_id: orderId,
      seq: 1,
      status: 'live',
      brand_document_type: 'invoice',
      brand_document_number: 'INV-1',
      brand_document_date: '2026-10-30',
      consignor_gstin: '29ABCDE1234F1Z5',
      consignor_snapshot: sql.json({ v: 1, code: 'ACME', name: 'Acme' }),
      declared_value_paise: 11_800_000,
      destination_state_code: '27',
      supply_type: 'inter',
      threshold_paise: 5_000_000,
      threshold_rule: 'national',
      eway_required: true,
      eway_status: 'pending',
      recorded_after_dispatch: false,
      source: 'portal',
      recorded_by: userId,
      recorded_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it('the trigger (outside the probe): a number is never rewritten; the ending columns and one dispatch stamp change', async () => {
    const row = recordRow(acme, uuidv7());
    await sql`insert into order_consignment_records ${sql(row)}`;
    await expect(sql`update order_consignment_records set brand_document_number = 'INV-2' where id = ${row.id as string}`).rejects.toThrow(/immutable/);
    await expect(sql`update order_consignment_records set declared_value_paise = 1 where id = ${row.id as string}`).rejects.toThrow(/immutable/);
    await sql`update order_consignment_records set dispatched_at = now() where id = ${row.id as string}`;
    await expect(sql`update order_consignment_records set dispatched_at = now() + interval '1 day' where id = ${row.id as string}`).rejects.toThrow(/stamped once/);
    await sql`update order_consignment_records set status = 'superseded', ended_at = now(), ended_by = ${userId}, end_reason = 'Amended' where id = ${row.id as string}`;
    expect(await sql`select status from order_consignment_records where id = ${row.id as string}`).toEqual([{ status: 'superseded' }]);
    // An ended version is frozen: never revived, its ending never rewritten.
    await expect(sql`update order_consignment_records set status = 'live', ended_at = null, ended_by = null, end_reason = null where id = ${row.id as string}`).rejects.toThrow(/an ended version/);
    await expect(sql`update order_consignment_records set end_reason = 'Rewritten' where id = ${row.id as string}`).rejects.toThrow(/an ended version/);
  });

  it('RLS (A1, A28): a client-stamped wms_rls_probe reads only its client’s records and writes only its own (the portal write set: supersede, insert); the operator shape sees both', async () => {
    const orderA = uuidv7();
    const orderB = uuidv7();
    await sql`insert into order_consignment_records ${sql(recordRow(acme, orderA))}`;
    await sql`insert into order_consignment_records ${sql(recordRow(beta, orderB))}`;
    await sql.unsafe(`do $$ begin
      if not exists (select from pg_roles where rolname = 'wms_rls_probe') then
        create role wms_rls_probe login password 'wms_rls_probe' nosuperuser;
      end if;
    end $$;`);
    await sql.unsafe('grant usage on schema public to wms_rls_probe');
    await sql.unsafe('grant select, insert, update on order_consignment_records to wms_rls_probe');
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
      const orders = async (tx: postgres.TransactionSql) =>
        ((await tx`select order_id from order_consignment_records where status = 'live' and order_id in (${orderA}, ${orderB})`) as unknown as { order_id: string }[])
          .map((r) => r.order_id)
          .sort();
      expect(await stamped(acme, orders)).toEqual([orderA]);
      expect(await stamped(beta, orders)).toEqual([orderB]);
      expect(await stamped(null, orders)).toEqual([orderA, orderB].sort());
      // Positive control — the portal write set under A's stamp: supersede A's live version and insert v2.
      await stamped(acme, async (tx) => {
        await tx`update order_consignment_records set status = 'superseded', ended_at = now(), ended_by = ${userId}, end_reason = 'Amended' where order_id = ${orderA} and status = 'live'`;
        await tx`insert into order_consignment_records ${tx(recordRow(acme, orderA, { seq: 2 }) as Record<string, postgres.ParameterOrJSON<never>>)}`;
      });
      expect(await sql`select seq, status from order_consignment_records where order_id = ${orderA} order by seq`).toEqual([
        { seq: 1, status: 'superseded' },
        { seq: 2, status: 'live' },
      ]);
      // A's stamp cannot write B's record (WITH CHECK), nor touch it (USING).
      await expect(stamped(acme, (tx) => tx`insert into order_consignment_records ${tx(recordRow(beta, uuidv7()) as Record<string, postgres.ParameterOrJSON<never>>)}`)).rejects.toThrow(/row-level security/);
      const touched = await stamped(acme, (tx) => tx`update order_consignment_records set status = 'withdrawn', ended_at = now(), ended_by = ${userId}, end_reason = 'x' where order_id = ${orderB} and status = 'live'`);
      expect(touched.count).toBe(0);
    } finally {
      await probe.end();
    }
  });
});
