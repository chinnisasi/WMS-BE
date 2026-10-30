import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { uuidv7 } from '../src/shared/primitives/ids';
import { createDatabase } from '../src/shared/db/db';
import { SHIPMENT_KINDS, SHIPMENT_STATUSES } from '../src/modules/outbound/shipment.command';
import {
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_OWNER_TYPES,
  ATTACHMENT_PURPOSES,
  ATTACHMENT_SOURCES,
  SHIPPING_DOC_KINDS,
} from '../src/modules/attachments/attachment-records';
import { EMAIL_ATTACHMENT_KINDS, EMAIL_TEMPLATES } from '../src/modules/mail/mail-rules';
import { CLIENT_EMAIL_EVENTS } from '../src/modules/clients/clients.schema';
import { HANDOVER_SOURCES } from '../src/modules/outbound/handover.command';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';

jest.setTimeout(180_000);

const MIGRATION = '0116_client_arranged_shipping.sql';

function migrationStatements(): string[] {
  return readFileSync(resolve(process.cwd(), 'drizzle', MIGRATION), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Story 4-4a (A6) — migration 0116 against a POPULATED database standing
 * exactly at 0115 (the repo's own migrations, journal trimmed — the 0112
 * harness), applied whole inside one transaction as the real runner applies
 * it: the client backfill of existing shipments, its two refusals (a shipment
 * whose order is gone; an order with two live shipments), the NOT VALID
 * CHECKs and their TS tuples, and the RLS client clause as `wms_rls_probe`.
 */
describe('migration 0116: client-arranged shipping', () => {
  const PRE_DB = 'wms_s_client_arranged_premigration';
  let sql: ReturnType<typeof postgres>;
  let folder: string;
  let preUrl: string;

  const tenantId = uuidv7();
  const acme = uuidv7();
  const beta = uuidv7();
  const warehouseId = uuidv7();
  const orderA = uuidv7();
  const orderB = uuidv7();
  const shipmentA = uuidv7();
  const shipmentB = uuidv7();

  async function order(id: string, clientId: string): Promise<void> {
    await sql`insert into orders (id, tenant_id, client_id, warehouse_id, status, source, destination_contact_name, destination_phone, destination_line1, destination_city, destination_state, destination_pincode)
      values (${id}, ${tenantId}, ${clientId}, ${warehouseId}, 'ready_to_dispatch', 'manual', 'Ravi', '9876543210', '1 Road', 'Bengaluru', 'KA', '560001')`;
  }

  async function shipment(id: string, orderId: string, status = 'labelled'): Promise<void> {
    await sql`insert into shipments (id, tenant_id, warehouse_id, order_id, status, carrier_connection_id, carrier_code, carrier_name, tracking_number, label_document_ref, labelled_by, labelled_at, voided_at, voided_by)
      values (${id}, ${tenantId}, ${warehouseId}, ${orderId}, ${status}, ${uuidv7()}, 'sandbox', 'Sandbox', ${`SBX-${id.slice(-8)}`}, 'sandbox://x', ${uuidv7()}, now(),
              ${status === 'voided' ? sql`now()` : null}, ${status === 'voided' ? uuidv7() : null})`;
  }

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
    folder = mkdtempSync(join(tmpdir(), 'wms-pre-0116-'));
    cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
    rmSync(join(folder, MIGRATION));
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 115);
    writeFileSync(journalPath, JSON.stringify(journal));
    const db = createDatabase(preUrl);
    await migrate(db, { migrationsFolder: folder });
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
    sql = postgres(preUrl, { max: 2, onnotice: () => undefined });
    expect(await sql`select count(*)::int as n from information_schema.tables where table_name = 'courier_handovers'`).toEqual([{ n: 0 }]);

    // ── the "before" state: 4.6c carrier shipments of two clients' orders ─
    await order(orderA, acme);
    await order(orderB, beta);
    await shipment(shipmentA, orderA);
    await shipment(shipmentB, orderB, 'voided');
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

  it('refuses (and rolls back whole) a shipment whose order is gone — the backfill must be complete', async () => {
    const orphan = uuidv7();
    await shipment(orphan, uuidv7());
    try {
      await expect(applyInOneTransaction()).rejects.toThrow(/still have no client_id after the backfill/);
      expect(await sql`select count(*)::int as n from information_schema.tables where table_name = 'courier_handovers'`).toEqual([{ n: 0 }]);
    } finally {
      await sql`delete from shipments where id = ${orphan}`;
    }
  });

  it('refuses an order with two live shipments before the one-live-shipment build', async () => {
    const second = uuidv7();
    await sql`drop index if exists shipments_tenant_order_labelled_unique`;
    await shipment(second, orderA);
    try {
      await expect(applyInOneTransaction()).rejects.toThrow(/have two non-voided shipments/);
    } finally {
      await sql`delete from shipments where id = ${second}`;
      await sql`create unique index if not exists shipments_tenant_order_labelled_unique on shipments (tenant_id, order_id) where status = 'labelled'`;
    }
  });

  it('applies over carrier shipments: every row is kind carrier with its client backfilled, the CHECKs NOT VALID and pinned against the TS tuples; a re-run fails fast', async () => {
    await applyInOneTransaction();
    const rows = (await sql`select id, kind, client_id, status from shipments where tenant_id = ${tenantId} order by id`) as unknown as { id: string; kind: string; client_id: string; status: string }[];
    expect(rows).toEqual(
      [
        { id: shipmentA, kind: 'carrier', client_id: acme, status: 'labelled' },
        { id: shipmentB, kind: 'carrier', client_id: beta, status: 'voided' },
      ].sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
    const checks = (await sql`select conname, pg_get_constraintdef(oid) as def, convalidated from pg_constraint
      where conrelid in ('public.shipments'::regclass, 'public.attachments'::regclass, 'public.courier_handovers'::regclass, 'public.email_messages'::regclass, 'public.client_contacts'::regclass)
        and contype = 'c'`) as unknown as { conname: string; def: string; convalidated: boolean }[];
    const def = (name: string) => checks.find((check) => check.conname === name)!;
    const literals = (name: string) => [...def(name).def.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
    expect(literals('shipments_kind_check')).toEqual([...SHIPMENT_KINDS]);
    expect(literals('shipments_status_check')).toEqual([...SHIPMENT_STATUSES]);
    expect(literals('attachments_purpose_check')).toEqual([...ATTACHMENT_PURPOSES]);
    expect(literals('attachments_source_check')).toEqual([...ATTACHMENT_SOURCES]);
    expect(literals('attachments_owner_type_check')).toEqual([...ATTACHMENT_OWNER_TYPES]);
    expect(literals('attachments_content_type_check')).toEqual([...ATTACHMENT_CONTENT_TYPES]);
    expect(literals('attachments_doc_kind_check').filter((value) => value !== 'shipping-document')).toEqual([...SHIPPING_DOC_KINDS]);
    expect(literals('courier_handovers_source_check')).toEqual([...HANDOVER_SOURCES]);
    expect(literals('email_messages_template_check')).toEqual([...EMAIL_TEMPLATES]);
    // 0116's set: the TS tuple as it stood at 0116 (4-5a's 0117 appends
    // `packing-slip-pdf`, pinned against the tuple by mail.spec.ts and
    // packing-documents-migration.spec.ts).
    expect(literals('email_messages_attachment_kind_check')).toEqual(EMAIL_ATTACHMENT_KINDS.filter((kind) => kind !== 'packing-slip-pdf'));
    expect(literals('client_contacts_email_events_check').filter((value, i, all) => all.indexOf(value) === i)).toEqual([...CLIENT_EMAIL_EVENTS]);
    // The twelve shipments CHECKs are NOT VALID (their VALIDATE is PENDING); the rest validated.
    const shipmentChecks = checks.filter((check) => check.conname.startsWith('shipments_') && !check.convalidated).map((check) => check.conname).sort();
    expect(shipmentChecks).toEqual(
      [
        'shipments_awb_shape',
        'shipments_carrier_arms',
        'shipments_client_label_file',
        'shipments_courier_pairing',
        'shipments_handover_pairing',
        'shipments_kind_check',
        'shipments_package_count_range',
        'shipments_recorded_surface',
        'shipments_status_by_kind',
        'shipments_status_check',
        'shipments_verified_pairing',
        'shipments_void_reason',
        // 0102's, still NOT VALID
        'shipments_voided_pairing',
      ].sort(),
    );
    expect(checks.filter((check) => !check.conname.startsWith('shipments_') && !check.convalidated)).toEqual([]);
    // The indexes.
    const indexes = (await sql`select indexname from pg_indexes where indexname in ('shipments_tenant_order_live_unique', 'shipments_client_awb_open_unique', 'shipments_handover_idx', 'orders_ready_to_dispatch_idx', 'attachments_tenant_owner_purpose_idx', 'courier_handovers_tenant_code_unique')`) as unknown as { indexname: string }[];
    expect(indexes).toHaveLength(6);
    // A re-run fails fast.
    await expect(applyInOneTransaction()).rejects.toThrow(/already been applied/);
  });

  it('RLS (A1, A2): a client-stamped wms_rls_probe sees only its client’s shipments and handovers; the operator shape sees the tenant’s', async () => {
    await sql`insert into courier_handovers (id, tenant_id, warehouse_id, client_id, code, courier_name, pickup_person_name, handed_over_at, shipment_count, package_count, cod_shipment_count, cod_total_paise, client_snapshot, warehouse_snapshot, source, created_by)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${beta}, 'HO-0001', 'VRL', 'Ravi', now(), 1, 1, 0, 0, '{}', '{}', 'web', ${uuidv7()})`;
    await sql.unsafe(`do $$ begin
      if not exists (select from pg_roles where rolname = 'wms_rls_probe') then
        create role wms_rls_probe login password 'wms_rls_probe' nosuperuser;
      end if;
    end $$;`);
    await sql.unsafe('grant usage on schema public to wms_rls_probe');
    await sql.unsafe('grant select on shipments, courier_handovers to wms_rls_probe');
    const probeUrl = new URL(preUrl);
    probeUrl.username = 'wms_rls_probe';
    probeUrl.password = 'wms_rls_probe';
    const probe = postgres(probeUrl.toString(), { max: 1, onnotice: () => undefined });
    try {
      const read = (clientId: string | null) =>
        probe.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
          if (clientId !== null) await tx`select set_config('app.client_id', ${clientId}, true)`;
          const ships = (await tx`select id from shipments`) as unknown as { id: string }[];
          const handovers = (await tx`select id from courier_handovers`) as unknown as { id: string }[];
          return { ships: ships.map((row) => row.id).sort(), handovers: handovers.length };
        });
      expect(await read(acme)).toEqual({ ships: [shipmentA], handovers: 0 });
      expect(await read(beta)).toEqual({ ships: [shipmentB], handovers: 1 });
      // Positive control: the operator shape sees both.
      expect((await read(null)).ships).toEqual([shipmentA, shipmentB].sort());
    } finally {
      await probe.end();
    }
  });

  it('A25 — the WHOLE portal write set runs under the client stamp: the reservation, its finalize, the shipment, a void, the outbox, the audit and the key; another client’s shipment is refused', async () => {
    await sql.unsafe('grant select, insert, update on attachments, shipments, orders, outbox_messages, audit_events, idempotency_keys to wms_rls_probe');
    const probeUrl = new URL(preUrl);
    probeUrl.username = 'wms_rls_probe';
    probeUrl.password = 'wms_rls_probe';
    const probe = postgres(probeUrl.toString(), { max: 1, onnotice: () => undefined });
    const orderC = uuidv7();
    await order(orderC, acme);
    const attachmentId = uuidv7();
    const shipmentId = uuidv7();
    const actor = uuidv7();
    try {
      await probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        await tx`select set_config('app.client_id', ${acme}, true)`;
        // The reservation carries its client from the start (A3, D9), then becomes the attached row.
        await tx`insert into attachments (id, tenant_id, client_id, warehouse_id, purpose, status, source, upload_key, upload_hash, raw_sha256, object_key, content_type, byte_size, sha256, width, height, page_count, created_by)
          values (${attachmentId}, ${tenantId}, ${acme}, ${warehouseId}, 'shipping-label', 'uploading', 'portal', 'PROBE-KEY', ${'b'.repeat(64)}, ${'c'.repeat(64)}, ${'probe/' + attachmentId}, 'application/pdf', 100, ${'a'.repeat(64)}, 288, 432, 2, ${actor})`;
        await tx`update attachments set status = 'attached', owner_type = 'order', owner_id = ${orderC}, owner_parent_id = ${orderC}, uploaded_at = now() where id = ${attachmentId}`;
        await tx`select id from orders where id = ${orderC} for update`;
        await tx`insert into shipments (id, tenant_id, warehouse_id, order_id, client_id, kind, status, carrier_name, tracking_number, label_attachment_id, labelled_by, labelled_at, recorded_surface)
          values (${shipmentId}, ${tenantId}, ${warehouseId}, ${orderC}, ${acme}, 'client-label', 'labelled', 'Delhivery', '123456789012', ${attachmentId}, ${actor}, now(), 'portal')`;
        await tx`update shipments set status = 'voided', voided_at = now(), voided_by = ${actor}, void_reason = 'Replaced by the client' where id = ${shipmentId}`;
        await tx`update attachments set status = 'removed', removed_by = ${actor}, removed_at = now(), removed_reason = 'Replaced by the client' where id = ${attachmentId}`;
        await tx`insert into outbox_messages (id, tenant_id, type, payload, occurred_at) values (${uuidv7()}, ${tenantId}, 'shipment.recorded', ${tx.json({ shipmentId })}, now())`;
        await tx`insert into audit_events (id, tenant_id, actor_user_id, action, target_type, target_id, reference, occurred_at)
          values (${uuidv7()}, ${tenantId}, ${actor}, 'shipment.client_label_recorded', 'order', ${orderC}, 'PROBE-KEY', now())`;
        await tx`insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot) values (${uuidv7()}, ${tenantId}, 'PROBE-KEY', 'probe', ${tx.json({ shipmentId })})`;
        // Positive control: another client's shipment is refused by the stamp.
        let refused: unknown = null;
        await tx
          .savepoint(async (sp) => {
            await sp`insert into shipments (id, tenant_id, warehouse_id, order_id, client_id, kind, status, carrier_name, tracking_number, label_attachment_id, labelled_by, labelled_at, recorded_surface)
              values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${orderB}, ${beta}, 'courier-label', 'labelled', 'VRL', 'LR1234', null, ${actor}, now(), 'portal')`;
          })
          .catch((err: unknown) => {
            refused = err;
          });
        expect(String((refused as Error | null)?.message)).toMatch(/row-level security/);
      });
      expect((await sql`select status, void_reason from shipments where id = ${shipmentId}`)[0]).toEqual({ status: 'voided', void_reason: 'Replaced by the client' });
    } finally {
      await probe.end();
    }
  });
});
