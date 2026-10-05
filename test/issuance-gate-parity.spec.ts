import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import Redis from 'ioredis';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { GSTIN_STATE_CODES, isGstinStateCode } from '../src/shared/primitives/gstin';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';
import { addressFingerprint, normalizeAddressInput } from '../src/shared/primitives/address';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

jest.setTimeout(60_000);

/** A GSTIN with the given two-digit prefix (the remaining 13 characters are shape-valid). */
const gstinWith = (prefix: string): string => `${prefix}AAACM4321K1Z8`;

/** The prefixes entry refuses: unassigned (92), merged (25), pre-GST (28), Centre Jurisdiction (99). */
const BAD_PREFIXES = ['92', '25', '28', '99'] as const;

/**
 * Story 8-1d — issuance-gate parity at ENTRY. The GSTIN state-prefix check
 * at registration, warehouse create and order create (one predicate, behind
 * each command's replay lookup), the buyer legal name's refusals and
 * persistence, and the hash-stability rule: the legal name joins the order's
 * two hashes ONLY when present, so every request without it hashes exactly
 * as the pre-8-1d build did (golden, byte for byte).
 *
 * The issue-time warnings live in `invoicing.spec.ts`; the e-way `toTrdName`
 * in `eway.spec.ts`; migration 0057 in `invoicing-migration.spec.ts`.
 */
describe('issuance-gate parity: GSTIN prefix at entry and the buyer legal name (e2e, story 8-1d)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let valkey: Redis;
  let suiteDb: SuiteDatabase;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let warehouseId: string;
  let skuId: string;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('issuance_gate');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await register({ name: `Gate Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery', gstin: gstinWith('29') }).expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = (
      await request(app.getHttpServer()).post(`${API}/sign-in`).send({ email, password: 'correct-horse-battery' }).expect(200)
    ).body.accessToken as string;

    warehouseId = (await postWarehouse({ code: `GT-${ulid().slice(10, 16)}`, name: 'Gate WH', origin: testAddress(), gstin: '29AAAPZ1234C1ZV' }).expect(201)).body
      .id as string;

    const csv = [
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode',
      'GT-1,Gate SKU,pcs,,500,0910,false,false,,,',
    ].join('\n');
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const list = await request(app.getHttpServer()).get(`${API}/${tenantId}/catalog/skus`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    skuId = (list.body.items as { id: string; code: string }[]).find((item) => item.code === 'GT-1')!.id;
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);
  });

  afterAll(async () => {
    let cleanupError: unknown;
    try {
      const cleaner = postgres(process.env.DATABASE_URL!, { max: 1 });
      try {
        for (const table of [
          'order_lines',
          'orders',
          'reservations',
          'outbox_messages',
          'idempotency_keys',
          'audit_events',
          'catalog_import_errors',
          'catalog_imports',
          'skus',
          'bins',
          'zones',
          'warehouses',
          'clients',
          'users',
          'tenants',
        ]) {
          await cleaner.unsafe(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [createdTenantIds]);
        }
        for (const tenant of createdTenantIds) {
          const keys = await valkey.keys(`wms:{${tenant}}:*`);
          if (keys.length > 0) await valkey.del(...keys);
        }
      } finally {
        await cleaner.end();
      }
    } catch (err) {
      cleanupError = err;
    }
    await valkey.quit().catch(() => valkey.disconnect());
    const rawDb = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await rawDb.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await sql.end();
    await app.close();
    await suiteDb.drop();
    if (cleanupError !== undefined) throw cleanupError;
  });

  // ── fixtures ───────────────────────────────────────────────────────────────

  function register(body: Record<string, unknown>, key = ulid()) {
    return request(app.getHttpServer()).post(API).set(KEY_HEADER, key).send(body);
  }

  function postWarehouse(body: Record<string, unknown>, key = ulid()) {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function orderBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { warehouseId, lines: [{ skuId, quantity: 2, ratePaise: 12_500 }], destination: testAddress(), ...extra };
  }

  function postOrder(body: Record<string, unknown>, key = ulid()) {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  async function storedHashes(orderId: string, key: string): Promise<{ payloadHash: string; sourcePayloadHash: string | null }> {
    const keyRows = await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`;
    const orderRows = await sql`select source_payload_hash from orders where id = ${orderId}`;
    return { payloadHash: keyRows[0]!.payload_hash as string, sourcePayloadHash: orderRows[0]!.source_payload_hash as string | null };
  }

  const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
  /** The destination exactly as both hashes fingerprint it (`testAddress()`, already normalized). */
  const DESTINATION_JSON =
    '{"contactName":"Priya Sharma","phone":"+91 98450 12345","line1":"12, Peenya Industrial Area","line2":"Gate 3","city":"Bengaluru","state":"Karnataka","pincode":"560066"}';

  // ── the registration-state-code constant ─────────────────────────────────

  it('GSTIN_STATE_CODES is exactly gst_state_codes minus 99 (sorted), and the predicate refuses 25, 28, 92 and 99', async () => {
    const rows = (await sql`select state_code from gst_state_codes order by state_code`) as unknown as { state_code: string }[];
    const all = rows.map((row) => row.state_code);
    expect(all).toContain('99'); // the exclusion is real, not vacuous
    expect([...GSTIN_STATE_CODES]).toEqual(all.filter((code) => code !== '99'));
    expect(GSTIN_STATE_CODES).toHaveLength(37);
    expect(['25', '28', '92', '99', '00', '96'].map(isGstinStateCode)).toEqual([false, false, false, false, false, false]);
    expect(['01', '26', '27', '29', '37', '38', '97'].map(isGstinStateCode)).toEqual([true, true, true, true, true, true, true]);
  });

  // ── refusals at entry ─────────────────────────────────────────────────────

  it('registration refuses a GSTIN whose prefix is not a registration state code (400, nothing written); 29 and 97 register', async () => {
    for (const prefix of BAD_PREFIXES) {
      const name = `Bad Prefix ${prefix} ${ulid()}`;
      const res = await register({ name, ownerEmail: `bad-${ulid().toLowerCase()}@example.com`, password: 'correct-horse-battery', gstin: gstinWith(prefix) }).expect(400);
      expect(res.body.code).toBe('validation-failed');
      expect(res.body.detail).toContain(`"${prefix}" is not a GST registration state code`);
      expect((await sql`select count(*)::int as n from tenants where name = ${name}`)[0]!.n).toBe(0);
    }
    for (const prefix of ['29', '97']) {
      const res = await register({ name: `Good ${prefix} ${ulid()}`, ownerEmail: `good-${ulid().toLowerCase()}@example.com`, password: 'correct-horse-battery', gstin: gstinWith(prefix) }).expect(201);
      createdTenantIds.push(res.body.tenant.id as string);
      expect(res.body.tenant.gstin).toBe(gstinWith(prefix));
    }
  });

  it('AC: a warehouse with GSTIN prefix 92 is refused 400 through the API and nothing is written; 97 is accepted', async () => {
    const count = async (): Promise<number> => (await sql`select count(*)::int as n from warehouses where tenant_id = ${tenantId}`)[0]!.n as number;
    const before = await count();
    for (const prefix of BAD_PREFIXES) {
      const res = await postWarehouse({ code: `BAD-${prefix}-${ulid().slice(12, 16)}`, name: 'Bad WH', origin: testAddress(), gstin: gstinWith(prefix) }).expect(400);
      expect(res.body.code).toBe('validation-failed');
      expect(res.body.detail).toContain(`"${prefix}" is not a GST registration state code`);
    }
    expect(await count()).toBe(before);
    // A GSTIN state that differs from the address state is NOT refused (the web warns; issuance warns).
    await postWarehouse({ code: `OK97-${ulid().slice(12, 16)}`, name: 'Other Territory WH', origin: testAddress(), gstin: gstinWith('97') }).expect(201);
    await postWarehouse({ code: `OK27-${ulid().slice(12, 16)}`, name: 'Mismatch WH', origin: testAddress({ state: 'Karnataka' }), gstin: gstinWith('27') }).expect(201);
    expect(await count()).toBe(before + 2);
  });

  it('order create refuses a consignee GSTIN whose prefix is not a registration state code; 29 and 97 are accepted', async () => {
    for (const prefix of BAD_PREFIXES) {
      const res = await postOrder(orderBody({ consigneeGstin: gstinWith(prefix) })).expect(400);
      expect(res.body.code).toBe('validation-failed');
      expect(res.body.detail).toContain(`consigneeGstin "${prefix}" is not a GST registration state code`);
    }
    for (const prefix of ['29', '97']) {
      await postOrder(orderBody({ consigneeGstin: gstinWith(prefix) })).expect(201);
    }
  });

  it('the prefix refusal runs BEHIND the replay lookup: a key committed before the rule still replays — order, warehouse and registration', async () => {
    // Commit an order under key K, then rewrite K's stored hash to the hash
    // a pre-8-1d build computed for a body carrying a 92… GSTIN (it accepted
    // that body). Re-sending that body under K must REPLAY, never 400.
    const key = ulid();
    const created = await postOrder(orderBody({ consigneeGstin: gstinWith('29') }), key).expect(201);
    const badBody = orderBody({ consigneeGstin: gstinWith('92') });
    const legacyHash = hashCommandPayload({
      tenantId,
      warehouseId,
      source: 'manual',
      integrationId: null,
      externalEventId: null,
      destination: addressFingerprint(normalizeAddressInput(testAddress() as never)) ?? null,
      consigneeGstin: gstinWith('92'),
      lines: [{ skuId, quantity: 2, ratePaise: 12_500 }],
    });
    await sql`update idempotency_keys set payload_hash = ${legacyHash} where tenant_id = ${tenantId} and key = ${key}`;
    const replayed = await postOrder(badBody, key).expect(201);
    expect(replayed.body.order.id).toBe(created.body.order.id);

    // The warehouse arm, the same way.
    const whKey = ulid();
    const code = `RPL-${ulid().slice(12, 16)}`;
    const wh = await postWarehouse({ code, name: 'Replay WH', origin: testAddress(), gstin: gstinWith('29') }, whKey).expect(201);
    const whLegacyHash = hashCommandPayload({
      tenantId,
      code,
      name: 'Replay WH',
      origin: addressFingerprint(normalizeAddressInput(testAddress() as never)) ?? null,
      gstin: gstinWith('92'),
    });
    await sql`update idempotency_keys set payload_hash = ${whLegacyHash} where tenant_id = ${tenantId} and key = ${whKey}`;
    const whReplayed = await postWarehouse({ code, name: 'Replay WH', origin: testAddress(), gstin: gstinWith('92') }, whKey).expect(201);
    expect(whReplayed.body.id).toBe(wh.body.id);

    // The registration arm (its replay lookup is by key alone, on AUTH_DATABASE).
    const regKey = ulid();
    const name = `Replay Co ${ulid()}`;
    const ownerEmail = `replay-${ulid().toLowerCase()}@example.com`;
    const registered = await register({ name, ownerEmail, password: 'correct-horse-battery', gstin: gstinWith('29') }, regKey).expect(201);
    createdTenantIds.push(registered.body.tenant.id as string);
    const regLegacyHash = hashCommandPayload({ name, ownerEmail, gstin: gstinWith('92') });
    await sql`update idempotency_keys set payload_hash = ${regLegacyHash} where key = ${regKey}`;
    const regReplayed = await register({ name, ownerEmail, password: 'correct-horse-battery', gstin: gstinWith('92') }, regKey).expect(201);
    expect(regReplayed.body.tenant.id).toBe(registered.body.tenant.id);
  });

  // ── the buyer legal name ──────────────────────────────────────────────────

  it('the legal name is refused without a GSTIN and over 100 code points (400 validation-failed); 100 astral code points fit', async () => {
    const withoutGstin = await postOrder(orderBody({ consigneeLegalName: 'Mysore Spices Pvt Ltd' })).expect(400);
    expect(withoutGstin.body.code).toBe('validation-failed');
    expect(withoutGstin.body.detail).toContain('needs a consigneeGstin');

    const tooLong = await postOrder(orderBody({ consigneeGstin: gstinWith('29'), consigneeLegalName: 'x'.repeat(101) })).expect(400);
    expect(tooLong.body.code).toBe('validation-failed');
    expect(tooLong.body.detail).toContain('at most 100 characters (got 101)');

    // 101 astral characters: 202 UTF-16 units, 101 code points → refused by count of code points…
    const astral = '𝐀';
    const astralLong = await postOrder(orderBody({ consigneeGstin: gstinWith('29'), consigneeLegalName: astral.repeat(101) })).expect(400);
    expect(astralLong.body.detail).toContain('(got 101)');
    // …and 100 code points (199 UTF-16 units) fit, as the column CHECK agrees.
    const hundred = `A${astral.repeat(99)}`;
    const fits = await postOrder(orderBody({ consigneeGstin: gstinWith('29'), consigneeLegalName: hundred })).expect(201);
    const stored = await sql`select consignee_legal_name from orders where id = ${fits.body.order.id as string}`;
    expect(stored[0]!.consignee_legal_name).toBe(hundred);
  });

  it('a legal name the e-way portal would print blank (no Latin letters or digits) is refused 400 — it would freeze an e-way block', async () => {
    for (const name of ['मैसूर मसाले', '𝐀𝐁𝐂', '—…—']) {
      const res = await postOrder(orderBody({ consigneeGstin: gstinWith('29'), consigneeLegalName: name })).expect(400);
      expect(res.body.code).toBe('validation-failed');
      expect(res.body.detail).toContain('must contain Latin letters or digits');
    }
    // A mixed name keeps its Latin part on the bill, so it is accepted.
    await postOrder(orderBody({ consigneeGstin: gstinWith('29'), consigneeLegalName: 'मैसूर Spices Pvt Ltd' })).expect(201);
  });

  it('a legal name with a control character (NUL, a line break, a tab) is refused 400 — never a 500 from the insert', async () => {
    for (const name of ['Mysore\u0000Spices', 'Mysore\nSpices', 'Mysore\tSpices', 'Mysore\u007FSpices']) {
      const res = await postOrder(orderBody({ consigneeGstin: gstinWith('29'), consigneeLegalName: name })).expect(400);
      expect(res.body.code).toBe('validation-failed');
      expect(res.body.detail).toContain('control characters');
    }
  });

  it('the legal name is trimmed and stored; a blank one reads as absent (even without a GSTIN); the order view never exposes it', async () => {
    const named = await postOrder(orderBody({ consigneeGstin: gstinWith('29'), consigneeLegalName: '  Mysore Spices Pvt Ltd  ' })).expect(201);
    const namedId = named.body.order.id as string;
    expect((await sql`select consignee_legal_name from orders where id = ${namedId}`)[0]!.consignee_legal_name).toBe('Mysore Spices Pvt Ltd');
    expect(JSON.stringify(named.body)).not.toContain('Mysore Spices');
    const view = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/outbound/orders/${namedId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(JSON.stringify(view.body)).not.toContain('Mysore Spices');
    expect(JSON.stringify(view.body)).not.toContain('LegalName');

    const blank = await postOrder(orderBody({ consigneeLegalName: '   ' })).expect(201);
    expect((await sql`select consignee_legal_name from orders where id = ${blank.body.order.id as string}`)[0]!.consignee_legal_name).toBeNull();
  });

  it('the legal-name refusals run BEHIND the replay lookup: a key committed with it replays even when today it would refuse', async () => {
    const key = ulid();
    const created = await postOrder(orderBody({ consigneeGstin: gstinWith('29') }), key).expect(201);
    // The hash of a body carrying a legal name but no GSTIN (refused today).
    const legacyHash = hashCommandPayload({
      tenantId,
      warehouseId,
      source: 'manual',
      integrationId: null,
      externalEventId: null,
      destination: addressFingerprint(normalizeAddressInput(testAddress() as never)) ?? null,
      consigneeGstin: null,
      consigneeLegalName: 'Mysore Spices Pvt Ltd',
      lines: [{ skuId, quantity: 2, ratePaise: 12_500 }],
    });
    await sql`update idempotency_keys set payload_hash = ${legacyHash} where tenant_id = ${tenantId} and key = ${key}`;
    const replayed = await postOrder(orderBody({ consigneeLegalName: 'Mysore Spices Pvt Ltd' }), key).expect(201);
    expect(replayed.body.order.id).toBe(created.body.order.id);
  });

  // ── hash stability (golden) ───────────────────────────────────────────────

  it('golden: an order without a legal name hashes byte-for-byte as the pre-8-1d build did — payloadHash AND sourcePayloadHash', async () => {
    // The expected bytes are WRITTEN OUT here, key by key, in the pre-8-1d
    // order. A key added for every request (an always-present
    // `consigneeLegalName: null`) changes both and fails this.
    const integrationId = uuidv7();
    const externalEventId = `evt-${ulid()}`;
    const linesJson = `[{"skuId":"${skuId}","quantity":2,"ratePaise":12500}]`;
    const expectedPayload = sha256(
      `{"tenantId":"${tenantId}","warehouseId":"${warehouseId}","source":"ingested","integrationId":"${integrationId}","externalEventId":"${externalEventId}","destination":${DESTINATION_JSON},"consigneeGstin":"${gstinWith('29')}","lines":${linesJson}}`,
    );
    const expectedSource = sha256(`{"warehouseId":"${warehouseId}","destination":${DESTINATION_JSON},"consigneeGstin":"${gstinWith('29')}","lines":${linesJson}}`);

    for (const legalName of [undefined, '', '   ']) {
      const key = ulid();
      const eventId = legalName === undefined ? externalEventId : `${externalEventId}-${legalName.length}`;
      const body = orderBody({
        source: 'ingested',
        integrationId,
        externalEventId: eventId,
        consigneeGstin: gstinWith('29'),
        ...(legalName === undefined ? {} : { consigneeLegalName: legalName }),
      });
      const created = await postOrder(body, key).expect(201);
      const hashes = await storedHashes(created.body.order.id as string, key);
      // A blank name is ABSENT: the same source hash; the payload hash differs only by the event id.
      expect(hashes.sourcePayloadHash).toBe(expectedSource);
      if (legalName === undefined) {
        expect(hashes.payloadHash).toBe(expectedPayload);
      } else {
        expect(hashes.payloadHash).toBe(
          sha256(
            `{"tenantId":"${tenantId}","warehouseId":"${warehouseId}","source":"ingested","integrationId":"${integrationId}","externalEventId":"${eventId}","destination":${DESTINATION_JSON},"consigneeGstin":"${gstinWith('29')}","lines":${linesJson}}`,
          ),
        );
      }
    }

    // A manual order without it: the pre-8-1d manual layout, and no source hash.
    const manualKey = ulid();
    const manual = await postOrder(orderBody({ consigneeGstin: gstinWith('29') }), manualKey).expect(201);
    const manualHashes = await storedHashes(manual.body.order.id as string, manualKey);
    expect(manualHashes.sourcePayloadHash).toBeNull();
    expect(manualHashes.payloadHash).toBe(
      sha256(
        `{"tenantId":"${tenantId}","warehouseId":"${warehouseId}","source":"manual","integrationId":null,"externalEventId":null,"destination":${DESTINATION_JSON},"consigneeGstin":"${gstinWith('29')}","lines":${linesJson}}`,
      ),
    );
  });

  it('with a legal name, both hashes carry it (normalized) right after consigneeGstin — so a renamed redelivery is a source conflict', async () => {
    const integrationId = uuidv7();
    const externalEventId = `evt-${ulid()}`;
    const key = ulid();
    const linesJson = `[{"skuId":"${skuId}","quantity":2,"ratePaise":12500}]`;
    const body = orderBody({
      source: 'ingested',
      integrationId,
      externalEventId,
      consigneeGstin: gstinWith('29'),
      consigneeLegalName: '  Mysore Spices Pvt Ltd ',
    });
    const created = await postOrder(body, key).expect(201);
    const hashes = await storedHashes(created.body.order.id as string, key);
    expect(hashes.sourcePayloadHash).toBe(
      sha256(`{"warehouseId":"${warehouseId}","destination":${DESTINATION_JSON},"consigneeGstin":"${gstinWith('29')}","consigneeLegalName":"Mysore Spices Pvt Ltd","lines":${linesJson}}`),
    );
    expect(hashes.payloadHash).toBe(
      sha256(
        `{"tenantId":"${tenantId}","warehouseId":"${warehouseId}","source":"ingested","integrationId":"${integrationId}","externalEventId":"${externalEventId}","destination":${DESTINATION_JSON},"consigneeGstin":"${gstinWith('29')}","consigneeLegalName":"Mysore Spices Pvt Ltd","lines":${linesJson}}`,
      ),
    );
    // The same channel event redelivered with the name trimmed differently resolves to the same order…
    const again = await postOrder({ ...body, consigneeLegalName: 'Mysore Spices Pvt Ltd' }).expect(201);
    expect(again.body.order.id).toBe(created.body.order.id);
    // …and with a different name it is a source conflict.
    const conflict = await postOrder({ ...body, consigneeLegalName: 'Another Name Ltd' });
    expect(conflict.status).toBe(422);
    expect(conflict.body.code).toBe('order-source-conflict');
  });
});
