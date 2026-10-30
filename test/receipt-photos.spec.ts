import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import type { Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { AttachmentsFacade } from '../src/modules/attachments/attachments.facade';
import type { FileStore, FilePut, PresignGet, PresignedUrl } from '../src/modules/attachments/file-store';
import { NoneFileStore } from '../src/modules/attachments/file-store';
import { ATTACHMENT_STATUSES, ATTACHMENT_SOURCES, ATTACHMENT_PURPOSES } from '../src/modules/attachments/attachment-records';
import { AttachmentSweepWorker } from '../src/jobs/jobs.module';
import { expectAuditRow } from './support/audit-guard';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';
import { createLinkedVendor, linkVendor } from './support/linked-vendor';

// Story 2-5a — damage photos on a goods-receipt line, and the attachments
// foundation under them: the handheld upload (device credential +
// x-op-operator), both binding orders (receipt first → awaited → filled;
// photo first → staged → attached), A2's fill/conflict table, the web add /
// remove / cancel, the staff and portal reads, the caps, the gate and the
// staging cap, the hash goldens, the review-row carry and Apply re-binding,
// RLS (tenant and client arms), the retention sweep and the OpenAPI paths.
// The file store is an in-memory fake assigned to the facade's port field.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;
delete process.env.ATTACHMENT_SWEEP_POLL_MS;

jest.setTimeout(180_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const OCCURRED_AT = '2026-10-19T04:30:00.000Z';
const FIXTURES = join(__dirname, 'fixtures', 'images');
const fixture = (name: string): Buffer => readFileSync(join(FIXTURES, name));
const JPEG = fixture('baseline.jpg');
const JPEG_2 = fixture('restart.jpg');
const JPEG_GPS = fixture('gps-exif-icc.jpg');
const PNG = fixture('sips.png');
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The in-memory file store (the port's e2e fake). */
class FakeFileStore implements FileStore {
  readonly mode = 'local' as const;
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();
  readonly deleted: string[] = [];
  failPut = false;
  failDelete = false;
  /** Runs inside `put` before it stores (race tests park here). */
  onPut: (() => Promise<void>) | null = null;

  async put(input: FilePut): Promise<void> {
    if (this.onPut !== null) await this.onPut();
    if (this.failPut) throw Object.assign(new Error('S3 is down'), { name: 'ServiceUnavailable' });
    this.objects.set(input.key, { bytes: Buffer.from(input.bytes), contentType: input.contentType });
  }

  // Story 4-4a — the port's read (the shipping-document mail renderer).
  async get(key: string): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (object === undefined) throw new Error(`no object ${key}`);
    return object.bytes;
  }

  async presignGet(input: PresignGet): Promise<PresignedUrl> {
    return {
      url: `https://attachments.example/${input.key}?ct=${encodeURIComponent(input.contentType)}&fn=${encodeURIComponent(input.filename)}`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  }

  async delete(key: string): Promise<void> {
    if (this.failDelete) throw Object.assign(new Error('delete failed'), { name: 'InternalError' });
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

interface AttachmentDbRow {
  id: string;
  status: string;
  source: string;
  client_ref: string | null;
  owner_id: string | null;
  owner_parent_id: string | null;
  client_id: string | null;
  warehouse_id: string | null;
  device_id: string | null;
  object_key: string | null;
  sha256: string | null;
  raw_sha256: string | null;
  purged_at: string | null;
  created_by: string | null;
}

describe('story 2-5a: damage photos on a receipt line (e2e)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let facade: AttachmentsFacade;
  let store: FakeFileStore;

  let tenantId: string;
  let ownerToken: string;
  let wh: string;
  let vendorId: string;
  let deviceId: string;
  let deviceToken: string;
  let operatorToken: string;
  let operatorUserId: string;
  let operatorEmail: string;
  let device2Id: string;
  let device2Token: string;
  let opsWeb: { token: string; userId: string };
  let operatorWeb: { token: string; userId: string };
  let accountant: { userId: string };
  let portalA: string;
  let portalB: string;
  const clientIds = new Map<string, string>();
  const skuIds = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const client = (code: string): string => clientIds.get(code)!;
  const sku = (clientCode: string, code: string): string => skuIds.get(`${clientCode}:${code}`)!;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('receipt_photos');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 3, onnotice: () => undefined });
    facade = app.get(AttachmentsFacade);
    store = new FakeFileStore();
    facade.fileStore = store;

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `RP Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    const signedIn = await mintSignIn(app, { email, password: 'correct-horse-battery' });
    ownerToken = signedIn.body.accessToken as string;

    wh = (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `RP-${ulid().slice(20)}`, name: 'RP warehouse' })
        .expect(201)
    ).body.id as string;
    await http()
      .post(`${API}/${tenantId}/warehouses/${wh}/zones`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'A', name: 'Aisle A' })
      .expect(201);
    vendorId = await createLinkedVendor(app, tenantId, ownerToken, { code: 'V-RP', name: 'RP Vendor' });
    for (const [code, name] of [
      ['ALFA', 'Alfa Brand'],
      ['BRAVO', 'Bravo Brand'],
      ['EXP', 'Expiry Brand'],
    ] as const) {
      const res = await http()
        .post(`${API}/${tenantId}/clients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code, name })
        .expect(201);
      clientIds.set(code, res.body.client.id as string);
      await linkVendor(app, tenantId, ownerToken, vendorId, res.body.client.id as string);
    }
    await importSkus('ALFA', [['A-1', false], ['A-2', false]]);
    await importSkus('BRAVO', [['B-1', false]]);
    await importSkus('EXP', [['E-B', true]]);
    await http()
      .put(`${API}/${tenantId}/clients/${client('EXP')}/receiving-policy`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ receivingToleranceBps: 0, qcOnReceipt: false, expiryRequired: true, minShelfLifeDays: 90 })
      .expect(200);

    const operator = await createMember('operator');
    operatorEmail = operator.email;
    operatorWeb = { token: operator.token, userId: operator.userId };
    const ops = await createMember('ops_manager');
    opsWeb = { token: ops.token, userId: ops.userId };
    accountant = { userId: (await createMember('accountant')).userId };
    ({ deviceId, deviceToken } = await enroll('RP dock'));
    operatorToken = await badgeIn(deviceToken, operatorEmail);
    operatorUserId = operator.userId;
    ({ deviceId: device2Id, deviceToken: device2Token } = await enroll('RP dock 2'));
    await badgeIn(device2Token, operatorEmail);
    portalA = await portalUser(client('ALFA'));
    portalB = await portalUser(client('BRAVO'));
  });

  afterAll(async () => {
    await sql?.end();
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function importSkus(clientCode: string, rows: readonly (readonly [string, boolean])[]): Promise<void> {
    const csv = [
      'sku_code,name,uom,gst_rate,barcode,batch_tracked',
      ...rows.map(([code, batch]) => `${code},${code} name,pcs,1800,${clientCode}-${code}-BC,${batch}`),
    ].join('\n');
    await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', client(clientCode))
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const stored = (await sql`select id, code from skus where tenant_id = ${tenantId} and client_id = ${client(clientCode)}`) as unknown as {
      id: string;
      code: string;
    }[];
    for (const row of stored) skuIds.set(`${clientCode}:${row.code}`, row.id);
  }

  async function createMember(role: 'ops_manager' | 'operator' | 'accountant'): Promise<{ email: string; token: string; userId: string }> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    const signed = await mintSignIn(app, { email, password: 'correct-horse-battery' });
    return { email, token: signed.body.accessToken as string, userId: invited.body.user.id as string };
  }

  async function portalUser(clientId: string): Promise<string> {
    const email = `portal-${ulid().toLowerCase()}@brand.example`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role: 'client', clientId })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    return (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;
  }

  async function enroll(label: string): Promise<{ deviceId: string; deviceToken: string }> {
    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label, pin: '2468' })
      .expect(201);
    return { deviceId: enrolled.body.device.id as string, deviceToken: enrolled.body.deviceToken as string };
  }

  async function badgeIn(token: string, email: string): Promise<string> {
    const badged = await http()
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operatorEmail: email, pin: '2468' })
      .expect(200);
    return badged.body.accessToken as string;
  }

  interface GrnLineBody {
    skuId: string;
    qty: number;
    batchCode?: string | null;
    mfgDate?: string | null;
    expiryDate?: string;
    damagedQty?: number;
    damageReasonCode?: string;
    photoRefs?: string[];
  }

  function line(skuId: string, qty: number, extra: Partial<GrnLineBody> = {}): GrnLineBody {
    return { skuId, batchCode: null, mfgDate: null, qty, ...extra };
  }

  function grnBody(clientCode: string, lines: GrnLineBody[], extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { warehouseId: wh, occurredAt: OCCURRED_AT, poId: null, blindReasonCode: 'other', clientId: client(clientCode), lines, ...extra };
  }

  function receive(body: Record<string, unknown>, key = ulid(), token = operatorToken): SupertestTest {
    return http().post(`${API}/${tenantId}/receiving/goods-receipts`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  function upload(
    ref: string,
    bytes: Buffer,
    options: { operator?: string | null; token?: string; capturedAt?: string | null; filename?: string; contentType?: string } = {},
  ): SupertestTest {
    const req = http()
      .post(`${API}/${tenantId}/receiving/receipt-photos`)
      .set('Authorization', `Bearer ${options.token ?? deviceToken}`)
      .set(KEY_HEADER, ref);
    const operator = options.operator === undefined ? operatorUserId : options.operator;
    if (operator !== null) req.set('x-op-operator', operator);
    const capturedAt = options.capturedAt === undefined ? '2026-10-19T04:20:00.000Z' : options.capturedAt;
    if (capturedAt !== null) req.field('capturedAt', capturedAt);
    return req.attach('file', bytes, { filename: options.filename ?? 'photo.jpg', contentType: options.contentType ?? 'image/jpeg' });
  }

  function webAdd(grnId: string, lineId: string, bytes: Buffer, token = opsWeb.token, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/receiving/goods-receipts/${grnId}/lines/${lineId}/photos`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .attach('file', bytes, { filename: 'evidence.jpg', contentType: 'image/jpeg' });
  }

  function remove(grnId: string, attachmentId: string, reason: string, token = opsWeb.token, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/receiving/goods-receipts/${grnId}/photos/${attachmentId}/remove`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ reason });
  }

  function listPhotos(grnId: string, token = ownerToken): SupertestTest {
    return http().get(`${API}/${tenantId}/receiving/goods-receipts/${grnId}/photos`).set('Authorization', `Bearer ${token}`);
  }

  async function rowsByRef(ref: string): Promise<AttachmentDbRow[]> {
    return (await sql`select * from attachments where tenant_id = ${tenantId} and client_ref = ${ref} order by created_at`) as unknown as AttachmentDbRow[];
  }

  async function rowById(id: string): Promise<AttachmentDbRow> {
    return ((await sql`select * from attachments where id = ${id}`) as unknown as AttachmentDbRow[])[0]!;
  }

  async function grnOf(body: Record<string, unknown>, key = ulid()): Promise<{ id: string; code: string; lines: { id: string }[]; key: string; body: Record<string, unknown> }> {
    const res = await receive(body, key).expect(201);
    const grn = res.body.goodsReceipt as { id: string; code: string; lines: { id: string }[] };
    return { ...grn, key, body: res.body as Record<string, unknown> };
  }

  async function payloadHashOf(key: string): Promise<string> {
    return ((await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)[0]!.payload_hash) as string;
  }

  // ── the device snapshot and storage off ────────────────────────────────────

  describe('the snapshot and FILE_STORE=none', () => {
    it('the device snapshot carries receiptPhotos — enabled only with a store; off hides the Photo button', async () => {
      const on = await http()
        .get(`${API}/${tenantId}/devices/catalog-snapshot`)
        .query({ warehouseId: wh })
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);
      expect(on.body.receiptPhotos).toEqual({ enabled: true, maxPerLine: 10, maxPerReceipt: 50, maxBytes: 10_485_760 });
      facade.fileStore = new NoneFileStore();
      try {
        const off = await http()
          .get(`${API}/${tenantId}/devices/catalog-snapshot`)
          .query({ warehouseId: wh })
          .set('Authorization', `Bearer ${operatorToken}`)
          .expect(200);
        expect(off.body.receiptPhotos.enabled).toBe(false);
      } finally {
        facade.fileStore = store;
      }
    });

    it('storage off: the upload is 503 file-storage-unavailable AFTER the replay lookup (a committed op still replays); receipts unchanged; reads list no URLs', async () => {
      const committed = ulid();
      expect((await upload(committed, JPEG).expect(201)).body).toEqual({ ref: committed, status: 'staged' });
      const grn = await grnOf(grnBody('ALFA', [line(sku('ALFA', 'A-1'), 1, { photoRefs: [committed] })]));
      facade.fileStore = new NoneFileStore();
      try {
        const fresh = await upload(ulid(), JPEG).expect(503);
        expect(fresh.body.code).toBe('file-storage-unavailable');
        // The committed op replays its snapshot.
        expect((await upload(committed, JPEG).expect(201)).body).toEqual({ ref: committed, status: 'staged' });
        // A receipt still books exactly as before.
        await grnOf(grnBody('ALFA', [line(sku('ALFA', 'A-1'), 2)]));
        const listed = await listPhotos(grn.id).expect(200);
        expect(listed.body.storageEnabled).toBe(false);
        expect(listed.body.photos.map((photo: { url: string | null }) => photo.url)).toEqual([null]);
        const added = await webAdd(grn.id, grn.lines[0]!.id, JPEG).expect(503);
        expect(added.body.code).toBe('file-storage-unavailable');
      } finally {
        facade.fileStore = store;
      }
    });
  });

  // ── both binding orders ────────────────────────────────────────────────────

  describe('binding: receipt first, photo first', () => {
    it('dead-zone receipt (B23): the receipt books byte-identically to one without photoRefs; the late uploads fill line 2; web and portal show both', async () => {
      const p1 = ulid();
      const p2 = ulid();
      const withPhotos = await grnOf(
        grnBody('ALFA', [line(sku('ALFA', 'A-1'), 3), line(sku('ALFA', 'A-2'), 2, { damagedQty: 1, damageReasonCode: 'crushed', photoRefs: [p1, p2] })]),
      );
      const without = await grnOf(
        grnBody('ALFA', [line(sku('ALFA', 'A-1'), 3), line(sku('ALFA', 'A-2'), 2, { damagedQty: 1, damageReasonCode: 'crushed' })]),
      );
      // Response bodies equal but for the per-receipt identities.
      const strip = (body: Record<string, unknown>): string =>
        JSON.stringify(body)
          .replaceAll(withPhotos.id, 'GRN')
          .replaceAll(without.id, 'GRN')
          .replaceAll(withPhotos.code, 'CODE')
          .replaceAll(without.code, 'CODE')
          .replace(/"id":"[0-9a-f-]{36}"/g, '"id":"X"')
          .replace(/"recordedAt":"[^"]+"/g, '"recordedAt":"T"');
      expect(strip(withPhotos.body)).toBe(strip(without.body));
      // The ledger rows: the same types and quantities.
      const ledger = async (grnId: string) =>
        (await sql`select type, quantity_delta::text as q from ledger_events where tenant_id = ${tenantId} and reference_doc->>'grnId' = ${grnId} order by seq`) as unknown as {
          type: string;
          q: string;
        }[];
      expect(await ledger(withPhotos.id)).toEqual(await ledger(without.id));
      // The stored snapshot is the response.
      const stored = (await sql`select response_snapshot from idempotency_keys where tenant_id = ${tenantId} and key = ${withPhotos.key}`)[0]!
        .response_snapshot as Record<string, unknown>;
      expect(stored).toEqual(withPhotos.body);

      // Two placeholders, owned by line 2, attributed to the GRN's client and warehouse (A27).
      for (const ref of [p1, p2]) {
        const [row] = await rowsByRef(ref);
        expect(row).toMatchObject({
          status: 'awaited',
          owner_id: withPhotos.lines[1]!.id,
          owner_parent_id: withPhotos.id,
          client_id: client('ALFA'),
          warehouse_id: wh,
          device_id: deviceId,
          object_key: null,
        });
      }
      const lines = await http()
        .get(`${API}/${tenantId}/receiving/goods-receipts/${withPhotos.id}/lines`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(lines.body.items.map((item: { photoCount: number; pendingPhotoCount: number }) => [item.photoCount, item.pendingPhotoCount])).toEqual([
        [0, 0],
        [0, 2],
      ]);

      // The photos sync later: each fills its placeholder.
      expect((await upload(p1, JPEG).expect(201)).body).toEqual({ ref: p1, status: 'attached' });
      expect((await upload(p2, JPEG_GPS).expect(201)).body).toEqual({ ref: p2, status: 'attached' });
      for (const ref of [p1, p2]) {
        const rows = await rowsByRef(ref);
        expect(rows).toHaveLength(1); // the reservation was deleted, never left beside it
        expect(rows[0]).toMatchObject({ status: 'attached', owner_id: withPhotos.lines[1]!.id });
        expect(store.objects.has(rows[0]!.object_key!)).toBe(true);
      }
      await expectAuditRow({
        tenantId,
        key: p1,
        action: 'receipt_photo.uploaded',
        targetType: 'attachment',
        targetId: (await rowsByRef(p1))[0]!.id,
        actorUserId: operatorUserId,
        alongside: [{ action: 'receipt_photo.attached', targetType: 'attachment', targetId: (await rowsByRef(p1))[0]!.id, actorUserId: operatorUserId }],
      });
      // A same-key replay re-serves and writes nothing more.
      expect((await upload(p1, JPEG).expect(201)).body).toEqual({ ref: p1, status: 'attached' });
      await expectAuditRow({
        tenantId,
        key: p1,
        action: 'receipt_photo.uploaded',
        targetType: 'attachment',
        targetId: (await rowsByRef(p1))[0]!.id,
        actorUserId: operatorUserId,
        alongside: [{ action: 'receipt_photo.attached', targetType: 'attachment', targetId: (await rowsByRef(p1))[0]!.id, actorUserId: operatorUserId }],
      });

      // The staff GRN list counts the receipt's attached photos (C25).
      const grnList = await http()
        .get(`${API}/${tenantId}/receiving/goods-receipts`)
        .query({ warehouseId: wh, limit: 200 })
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      const listRow = (grnList.body.items as { id: string; photoCount: number }[]);
      expect(listRow.find((item) => item.id === withPhotos.id)!.photoCount).toBe(2);
      expect(listRow.find((item) => item.id === without.id)!.photoCount).toBe(0);

      // The web list: both on line 2, attached, presigned with a server-built name.
      const listed = await listPhotos(withPhotos.id).expect(200);
      expect(listed.body.storageEnabled).toBe(true);
      expect(listed.body.photos).toHaveLength(2);
      for (const photo of listed.body.photos as Record<string, unknown>[]) {
        expect(photo).toMatchObject({ grnLineId: withPhotos.lines[1]!.id, lineNo: 2, status: 'attached', source: 'handheld', contentType: 'image/jpeg' });
        expect(photo.fileName).toMatch(new RegExp(`^${withPhotos.code}-L2-[12]\\.jpg$`));
        expect(photo.url).toContain(`fn=${encodeURIComponent(photo.fileName as string)}`);
        expect(photo.url).toContain('ct=image%2Fjpeg');
      }
      // The portal of the receipt's client sees both photos on line 2.
      const portal = await http()
        .get(`${API}/${tenantId}/portal/inbound/goods-receipts/${withPhotos.id}`)
        .set('Authorization', `Bearer ${portalA}`)
        .expect(200);
      expect(portal.body.lines.map((portalLine: { photos: unknown[] }) => portalLine.photos.length)).toEqual([0, 2]);
      expect(portal.body.photoCount).toBe(2);
      expect(Object.keys(portal.body.lines[1].photos[0]).sort()).toEqual(['capturedAt', 'height', 'id', 'status', 'url', 'urlExpiresAt', 'width']);
    });

    it('photo first: the upload is staged; the receipt (same device) attaches it, audited under the GRN key', async () => {
      const ref = ulid();
      expect((await upload(ref, JPEG_2).expect(201)).body).toEqual({ ref, status: 'staged' });
      const staged = (await rowsByRef(ref))[0]!;
      expect(staged).toMatchObject({ status: 'staged', owner_id: null, client_id: null, device_id: deviceId, created_by: operatorUserId });
      await expectAuditRow({ tenantId, key: ref, action: 'receipt_photo.uploaded', targetType: 'attachment', targetId: staged.id, actorUserId: operatorUserId });
      const grn = await grnOf(grnBody('ALFA', [line(sku('ALFA', 'A-1'), 1, { photoRefs: [ref] })]));
      expect(await rowById(staged.id)).toMatchObject({ status: 'attached', owner_id: grn.lines[0]!.id, owner_parent_id: grn.id, client_id: client('ALFA'), warehouse_id: wh });
      const grnRow = ((await sql`select id from goods_receipt_notes where id = ${grn.id}`) as unknown as { id: string }[])[0]!;
      await expectAuditRow({
        tenantId,
        key: grn.key,
        action: 'goods_receipt.submitted',
        targetType: 'goods_receipt',
        targetId: grnRow.id,
        actorUserId: operatorUserId,
        alongside: [{ action: 'receipt_photo.attached', targetType: 'attachment', targetId: staged.id, actorUserId: operatorUserId }],
      });
      // A replayed receipt writes no second claim.
      await receive(grnBody('ALFA', [line(sku('ALFA', 'A-1'), 1, { photoRefs: [ref] })]), grn.key).expect(201);
      await expectAuditRow({
        tenantId,
        key: grn.key,
        action: 'goods_receipt.submitted',
        targetType: 'goods_receipt',
        targetId: grnRow.id,
        actorUserId: operatorUserId,
        alongside: [{ action: 'receipt_photo.attached', targetType: 'attachment', targetId: staged.id, actorUserId: operatorUserId }],
      });
    });

    it('stale or foreign refs are skipped, never a refusal: another device\'s staged photo, a photo already attached elsewhere (ref-skipped audit)', async () => {
      const foreign = ulid();
      await upload(foreign, JPEG, { token: device2Token }).expect(201);
      const attachedElsewhere = ulid();
      await upload(attachedElsewhere, JPEG_2).expect(201);
      await grnOf(grnBody('ALFA', [line(sku('ALFA', 'A-1'), 1, { photoRefs: [attachedElsewhere] })]));
      const grn = await grnOf(grnBody('ALFA', [line(sku('ALFA', 'A-1'), 1, { photoRefs: [foreign, attachedElsewhere] })]));
      expect((await rowsByRef(foreign))[0]).toMatchObject({ status: 'staged', owner_id: null, device_id: device2Id });
      expect((await rowsByRef(attachedElsewhere))[0]!.owner_parent_id).not.toBe(grn.id);
      await expectAuditRow({
        tenantId,
        key: grn.key,
        action: 'goods_receipt.submitted',
        targetType: 'goods_receipt',
        targetId: grn.id,
        actorUserId: operatorUserId,
        alongside: [{ action: 'receipt_photo.ref-skipped', targetType: 'goods_receipt', targetId: grn.id, actorUserId: operatorUserId }],
      });
      const skipped = (await sql`select changes from audit_events where tenant_id = ${tenantId} and reference = ${grn.key} and action = 'receipt_photo.ref-skipped'`)[0]!
        .changes as { skippedRefs: string[] };
      expect(skipped.skippedRefs.sort()).toEqual([foreign, attachedElsewhere].sort());
    });

    it('the refs\' shape: not ULIDs, > 10 per line, > 50 per receipt, or duplicated — a 400 above the transaction, nothing written', async () => {
      const before = Number((await sql`select count(*)::int as n from goods_receipt_notes where tenant_id = ${tenantId}`)[0]!.n);
      const refs = (n: number) => Array.from({ length: n }, () => ulid());
      const dup = ulid();
      const cases: Record<string, unknown>[] = [
        grnBody('ALFA', [line(sku('ALFA', 'A-1'), 1, { photoRefs: ['not-a-ulid'] })]),
        grnBody('ALFA', [line(sku('ALFA', 'A-1'), 1, { photoRefs: refs(11) })]),
        grnBody('ALFA', Array.from({ length: 6 }, () => line(sku('ALFA', 'A-1'), 1, { photoRefs: refs(9) }))),
        grnBody('ALFA', [line(sku('ALFA', 'A-1'), 1, { photoRefs: [dup] }), line(sku('ALFA', 'A-2'), 1, { photoRefs: [dup] })]),
      ];
      for (const body of cases) {
        const res = await receive(body).expect(400);
        expect(res.body.code).toBe('validation-failed');
      }
      expect(Number((await sql`select count(*)::int as n from goods_receipt_notes where tenant_id = ${tenantId}`)[0]!.n)).toBe(before);
    });

    it('both binding orders under a parked advisory lock: exactly one attached row whichever commits first (A1)', async () => {
      for (const order of ['receipt-first', 'photo-first'] as const) {
        const ref = ulid();
        const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
        let receipt: Promise<request.Response> | undefined;
        let photo: Promise<request.Response> | undefined;
        try {
          await holder.begin(async (tx) => {
            const pid = (await tx`select pg_backend_pid() as pid, pg_advisory_xact_lock(hashtext(${'attachment-ref:' + tenantId}), hashtext(${ref}))`)[0]!
              .pid as number;
            if (order === 'receipt-first') {
              receipt = (async () => receive(grnBody('ALFA', [line(sku('ALFA', 'A-1'), 1, { photoRefs: [ref] })])))();
              await waitAdvisoryParked(pid, 1);
              photo = (async () => upload(ref, JPEG))();
            } else {
              photo = (async () => upload(ref, JPEG))();
              await waitAdvisoryParked(pid, 1);
              receipt = (async () => receive(grnBody('ALFA', [line(sku('ALFA', 'A-1'), 1, { photoRefs: [ref] })])))();
            }
            await waitAdvisoryParked(pid, 2);
          });
          const [r, p] = await Promise.all([receipt!, photo!]);
          expect(r.status).toBe(201);
          expect(p.status).toBe(201);
          const rows = await rowsByRef(ref);
          expect(rows.map((row) => row.status)).toEqual(['attached']);
          expect(rows[0]!.owner_parent_id).toBe((r.body.goodsReceipt as { id: string }).id);
          expect(rows[0]!.object_key).not.toBeNull();
        } finally {
          await Promise.allSettled([receipt, photo]);
          await holder.end();
        }
      }
    });
  });

  // ── A2's table ─────────────────────────────────────────────────────────────

  describe("the upload's final transaction (A2)", () => {
    it('expired then late: the upload fills the expired placeholder → attached', async () => {
      const ref = ulid();
      const grn = await grnOf(grnBody('ALFA', [line(sku('ALFA', 'A-1'), 1, { photoRefs: [ref] })]));
      await sql`update attachments set status = 'expired' where tenant_id = ${tenantId} and client_ref = ${ref}`;
      expect((await upload(ref, JPEG).expect(201)).body.status).toBe('attached');
      expect((await rowsByRef(ref)).map((row) => [row.status, row.owner_parent_id])).toEqual([['attached', grn.id]]);
    });

    it('same ref, same bytes under a NEW key cannot happen (the ref is the key) — a same-key retry replays; same ref and other bytes is 422 key reuse', async () => {
      const ref = ulid();
      await upload(ref, JPEG).expect(201);
      const reuse = await upload(ref, JPEG_2).expect(422);
      expect(reuse.body.code).toBe('idempotency-key-reuse');
    });

    it('a ref row meeting another upload: same raw bytes → the replay-shaped body; other bytes → 409 attachment-ref-conflict', async () => {
      // A ref whose row exists but whose key does not (a web-cancelled
      // placeholder re-uploaded, or a key lost): simulated by deleting the key.
      const ref = ulid();
      await upload(ref, JPEG).expect(201);
      await sql`delete from idempotency_keys where tenant_id = ${tenantId} and key = ${ref}`;
      expect((await upload(ref, JPEG).expect(201)).body).toEqual({ ref, status: 'staged' });
      const rows = (await sql`select status from attachments where tenant_id = ${tenantId} and upload_key = ${ref} order by created_at`) as unknown as { status: string }[];
      expect(rows.map((row) => row.status)).toEqual(['staged', 'discarded']); // the duplicate reservation is discarded for the sweep
      await sql`delete from idempotency_keys where tenant_id = ${tenantId} and key = ${ref}`;
      const conflict = await upload(ref, JPEG_2).expect(409);
      expect(conflict.body.code).toBe('attachment-ref-conflict');
    });

    it('a discarded ref is history: a new upload stages a fresh row beside it', async () => {
      const ref = ulid();
      await upload(ref, JPEG).expect(201);
      await sql`update attachments set status = 'discarded' where tenant_id = ${tenantId} and client_ref = ${ref}`;
      await sql`delete from idempotency_keys where tenant_id = ${tenantId} and key = ${ref}`;
      expect((await upload(ref, JPEG).expect(201)).body.status).toBe('staged');
      expect((await rowsByRef(ref)).map((row) => row.status).sort()).toEqual(['discarded', 'staged']);
    });

    it('S3 down: 503 file-storage-failed, the reservation stays; the same-key retry reuses it (one row)', async () => {
      const ref = ulid();
      store.failPut = true;
      try {
        expect((await upload(ref, JPEG).expect(503)).body.code).toBe('file-storage-failed');
      } finally {
        store.failPut = false;
      }
      const reservations = (await sql`select id, status, client_ref from attachments where tenant_id = ${tenantId} and upload_key = ${ref}`) as unknown as {
        id: string;
        status: string;
        client_ref: string | null;
      }[];
      expect(reservations).toEqual([{ id: expect.any(String), status: 'uploading', client_ref: null }]);
      // Other bytes against the reservation's hash: 422.
      expect((await upload(ref, JPEG_2).expect(422)).body.code).toBe('idempotency-key-reuse');
      expect((await upload(ref, JPEG).expect(201)).body.status).toBe('staged');
      expect((await rowsByRef(ref)).map((row) => row.id)).toEqual([reservations[0]!.id]);
    });

    it('the sweep discarded the reservation before the finalize: 503 file-storage-failed; the retry makes a new reservation', async () => {
      const ref = ulid();
      store.onPut = async () => {
        await sql`update attachments set status = 'discarded' where tenant_id = ${tenantId} and upload_key = ${ref} and status = 'uploading'`;
      };
      try {
        expect((await upload(ref, JPEG).expect(503)).body.code).toBe('file-storage-failed');
      } finally {
        store.onPut = null;
      }
      expect((await upload(ref, JPEG).expect(201)).body.status).toBe('staged');
      const rows = (await sql`select status from attachments where tenant_id = ${tenantId} and upload_key = ${ref} order by created_at`) as unknown as { status: string }[];
      expect(rows.map((row) => row.status)).toEqual(['discarded', 'staged']);
    });
  });

  // ── bad files, EXIF ────────────────────────────────────────────────────────

  describe('the sanitizer at the edge', () => {
    it('bad files: SVG / HEIC / APNG 415, truncated / 11 MB / 8,001 px 422 — nothing stored', async () => {
      const before = Number((await sql`select count(*)::int as n from attachments where tenant_id = ${tenantId}`)[0]!.n);
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      expect((await upload(ulid(), svg, { contentType: 'image/svg+xml' }).expect(415)).body.code).toBe('attachment-type-unsupported');
      const heic = await upload(ulid(), fixture('photo.heic')).expect(415);
      expect(heic.body.code).toBe('attachment-type-unsupported');
      expect(heic.body.detail).toContain('HEIC photos are not supported');
      expect((await upload(ulid(), fixture('animated.png')).expect(415)).body.code).toBe('attachment-type-unsupported');
      expect((await upload(ulid(), JPEG.subarray(0, 300)).expect(422)).body.code).toBe('attachment-content-invalid');
      const big = Buffer.concat([JPEG.subarray(0, 2), Buffer.alloc(11 * 1024 * 1024)]);
      expect((await upload(ulid(), big).expect(422)).body.code).toBe('attachment-too-large');
      expect((await upload(ulid(), fixture('wide-8001.jpg')).expect(422)).body.code).toBe('attachment-content-invalid');
      expect(Number((await sql`select count(*)::int as n from attachments where tenant_id = ${tenantId}`)[0]!.n)).toBe(before);
    });

    it('EXIF/GPS: the stored bytes carry no APP1, and the stored sha256 is of the stored bytes', async () => {
      const ref = ulid();
      await upload(ref, JPEG_GPS).expect(201);
      const row = (await rowsByRef(ref))[0]!;
      const stored = store.objects.get(row.object_key!)!;
      expect(stored.contentType).toBe('image/jpeg');
      expect(stored.bytes.includes(Buffer.from('Exif\0\0'))).toBe(false);
      expect(row.sha256).toBe(sha256(stored.bytes));
      expect(row.raw_sha256).toBe(sha256(JPEG_GPS));
      expect(row.sha256).not.toBe(row.raw_sha256);
    });

    it('the shape above the transaction: no x-op-operator, a bad capturedAt, no file — 400; no key — 400', async () => {
      expect((await upload(ulid(), JPEG, { operator: null }).expect(400)).body.code).toBe('validation-failed');
      expect((await upload(ulid(), JPEG, { capturedAt: '2026-10-19 04:20' }).expect(400)).body.code).toBe('validation-failed');
      expect((await upload(ulid(), JPEG, { capturedAt: null }).expect(400)).body.code).toBe('validation-failed');
      const noFile = await http()
        .post(`${API}/${tenantId}/receiving/receipt-photos`)
        .set('Authorization', `Bearer ${deviceToken}`)
        .set(KEY_HEADER, ulid())
        .set('x-op-operator', operatorUserId)
        .field('capturedAt', '2026-10-19T04:20:00.000Z')
        .expect(400);
      expect(noFile.body.code).toBe('validation-failed');
      const noKey = await http()
        .post(`${API}/${tenantId}/receiving/receipt-photos`)
        .set('Authorization', `Bearer ${deviceToken}`)
        .set('x-op-operator', operatorUserId)
        .field('capturedAt', '2026-10-19T04:20:00.000Z')
        .attach('file', JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' })
        .expect(400);
      expect(noKey.body.code).toBe('idempotency-key-required');
      const unauthenticated = await http()
        .post(`${API}/${tenantId}/receiving/receipt-photos`)
        .set(KEY_HEADER, ulid())
        .attach('file', JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' })
        .expect(401);
      expect(unauthenticated.body.code).toBe('unauthenticated');
    });

    it('capturedAt is stored clamped to [now − 60 d, now + 10 min]; the hash keeps the raw value', async () => {
      const ref = ulid();
      await upload(ref, JPEG, { capturedAt: '2001-01-01T00:00:00.000Z' }).expect(201);
      const stored = ((await sql`select captured_at from attachments where tenant_id = ${tenantId} and client_ref = ${ref}`)[0]!.captured_at) as Date;
      expect(Date.now() - stored.getTime()).toBeGreaterThan(59 * 86_400_000);
      expect(Date.now() - stored.getTime()).toBeLessThan(61 * 86_400_000);
      // The replay still matches on the RAW value; another value is key reuse.
      await upload(ref, JPEG, { capturedAt: '2001-01-01T00:00:00.000Z' }).expect(201);
      expect((await upload(ref, JPEG, { capturedAt: '2001-01-02T00:00:00.000Z' }).expect(422)).body.code).toBe('idempotency-key-reuse');
    });
  });

  // ── authority: the device credential, the web capabilities ─────────────────

  describe('authority', () => {
    it('A7: the device credential + x-op-operator uploads after the capturer badged out and another badged in; attributed to the capturer', async () => {
      const second = await createMember('operator');
      const { deviceToken: token } = await enroll('RP swap');
      const badgeToken = await badgeIn(token, operatorEmail);
      await http().post(`${API}/${tenantId}/devices/badge-out`).set('Authorization', `Bearer ${badgeToken}`).send({}).expect((res) => {
        expect([200, 204]).toContain(res.status);
      });
      await badgeIn(token, second.email);
      const ref = ulid();
      expect((await upload(ref, JPEG, { token, operator: operatorUserId }).expect(201)).body.status).toBe('staged');
      const row = (await rowsByRef(ref))[0]!;
      expect(row.created_by).toBe(operatorUserId);
      await expectAuditRow({ tenantId, key: ref, action: 'receipt_photo.uploaded', targetType: 'attachment', targetId: row.id, actorUserId: operatorUserId });
    });

    it('A7: the capturer is re-authorized — an accountant is 403 role-denied, a revoked device 403 device-revoked', async () => {
      expect((await upload(ulid(), JPEG, { operator: accountant.userId }).expect(403)).body.code).toBe('role-denied');
      const { deviceId: doomedId, deviceToken: doomed } = await enroll('RP doomed');
      await badgeIn(doomed, operatorEmail);
      await http()
        .post(`${API}/${tenantId}/devices/${doomedId}/revoke`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({})
        .expect(200);
      expect((await upload(ulid(), JPEG, { token: doomed }).expect(403)).body.code).toBe('device-revoked');
    });

    it('web: an operator adds (receipt.attach) but cannot remove (403 role-denied); a manager removes; remove twice is 409; a same-key retry replays', async () => {
      const grn = await grnOf(grnBody('ALFA', [line(sku('ALFA', 'A-1'), 1)]));
      const added = await webAdd(grn.id, grn.lines[0]!.id, PNG, operatorWeb.token).expect(201);
      const attachment = added.body.attachment as Record<string, unknown>;
      expect(attachment).toEqual({
        id: expect.any(String),
        grnLineId: grn.lines[0]!.id,
        status: 'attached',
        contentType: 'image/png',
        byteSize: expect.any(Number),
        width: expect.any(Number),
        height: expect.any(Number),
        capturedAt: null,
        uploadedAt: expect.any(String),
        source: 'web',
      });
      expect(JSON.stringify(added.body)).not.toContain('http'); // no URL in a stored snapshot (A14)
      const addKey = (await sql`select reference from audit_events where tenant_id = ${tenantId} and action = 'receipt_photo.added' and target_id = ${attachment.id as string}`)[0]!
        .reference as string;
      await expectAuditRow({ tenantId, key: addKey, action: 'receipt_photo.added', targetType: 'attachment', targetId: attachment.id as string, actorUserId: operatorWeb.userId });

      const denied = await remove(grn.id, attachment.id as string, 'Wrong line', operatorWeb.token).expect(403);
      expect(denied.body.code).toBe('role-denied');
      const key = ulid();
      const removed = await remove(grn.id, attachment.id as string, 'Wrong line', opsWeb.token, key).expect(200);
      expect(removed.body.attachment).toMatchObject({ id: attachment.id, status: 'removed', removedAt: expect.any(String) });
      expect((await remove(grn.id, attachment.id as string, 'Wrong line', opsWeb.token, key).expect(200)).body).toEqual(removed.body);
      await expectAuditRow({ tenantId, key, action: 'receipt_photo.removed', targetType: 'attachment', targetId: attachment.id as string, actorUserId: opsWeb.userId });
      expect((await remove(grn.id, attachment.id as string, 'Again').expect(409)).body.code).toBe('attachment-not-attached');
      expect((await remove(grn.id, attachment.id as string, '   ').expect(400)).body.code).toBe('validation-failed');
      expect((await remove(grn.id, uuidv7(), 'x').expect(404)).body.code).toBe('not-found');

      // Staff still see it: status, remover, reason — no URL.
      const listed = await listPhotos(grn.id).expect(200);
      expect(listed.body.photos[0]).toMatchObject({ status: 'removed', url: null, removedBy: opsWeb.userId, removedReason: 'Wrong line' });
      expect(typeof listed.body.photos[0].removedByName).toBe('string');
    });

    it('cancel an awaited placeholder: removed with no object', async () => {
      const ref = ulid();
      const grn = await grnOf(grnBody('ALFA', [line(sku('ALFA', 'A-1'), 1, { photoRefs: [ref] })]));
      const row = (await rowsByRef(ref))[0]!;
      const res = await remove(grn.id, row.id, 'Never taken').expect(200);
      expect(res.body.attachment).toMatchObject({ status: 'removed', contentType: null, byteSize: null });
      expect(await rowById(row.id)).toMatchObject({ status: 'removed', object_key: null });
      // The portal shows neither a cancelled placeholder nor an awaited one (C26).
      const awaitedRef = ulid();
      const grn2 = await grnOf(grnBody('ALFA', [line(sku('ALFA', 'A-1'), 1, { photoRefs: [awaitedRef] })]));
      await remove(grn2.id, (await rowsByRef(awaitedRef))[0]!.id, 'Never taken').expect(200);
      const grn3 = await grnOf(grnBody('ALFA', [line(sku('ALFA', 'A-1'), 1, { photoRefs: [ulid()] })]));
      for (const id of [grn.id, grn2.id, grn3.id]) {
        const portal = await http().get(`${API}/${tenantId}/portal/inbound/goods-receipts/${id}`).set('Authorization', `Bearer ${portalA}`).expect(200);
        expect(portal.body.lines[0].photos).toEqual([]);
      }
      // The photo arriving after its placeholder was cancelled: 201 `removed`,
      // stored nowhere — never a ref conflict (C2).
      expect((await upload(ref, JPEG).expect(201)).body).toEqual({ ref, status: 'removed' });
      expect(await rowById(row.id)).toMatchObject({ status: 'removed', object_key: null });
      const reservations = (await sql`select status from attachments where tenant_id = ${tenantId} and upload_key = ${ref}`) as unknown as { status: string }[];
      expect(reservations.map((r) => r.status)).toEqual(['discarded']);
    });

    it('web add: unknown line 404, a full line 409 attachment-limit-reached (10 live = attached + awaited)', async () => {
      const refs = Array.from({ length: 9 }, () => ulid());
      const grn = await grnOf(grnBody('ALFA', [line(sku('ALFA', 'A-1'), 1, { photoRefs: refs })]));
      expect((await webAdd(grn.id, uuidv7(), JPEG).expect(404)).body.code).toBe('not-found');
      await webAdd(grn.id, grn.lines[0]!.id, JPEG).expect(201);
      const full = await webAdd(grn.id, grn.lines[0]!.id, JPEG_2).expect(409);
      expect(full.body.code).toBe('attachment-limit-reached');
      expect(full.body.detail).toContain('at most 10 per line');
    });

    it('web add, the same key twice while the line is locked: both answer the same 201, one photo, one key (raceTwice)', async () => {
      const grn = await grnOf(grnBody('ALFA', [line(sku('ALFA', 'A-2'), 1)]));
      const key = ulid();
      const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
      let first: Promise<request.Response> | undefined;
      let second: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const pid = (await tx`select pg_backend_pid() as pid from goods_receipt_lines where id = ${grn.lines[0]!.id} for update`)[0]!.pid as number;
          first = (async () => webAdd(grn.id, grn.lines[0]!.id, JPEG, opsWeb.token, key))();
          second = (async () => webAdd(grn.id, grn.lines[0]!.id, JPEG, opsWeb.token, key))();
          await waitRowParked(pid, 1);
        });
        const [a, b] = await Promise.all([first!, second!]);
        expect([a.status, b.status]).toEqual([201, 201]);
        expect(a.body).toEqual(b.body);
        const rows = (await sql`select status from attachments where tenant_id = ${tenantId} and owner_id = ${grn.lines[0]!.id}`) as unknown as { status: string }[];
        expect(rows.map((row) => row.status)).toEqual(['attached']);
        expect(Number((await sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)[0]!.n)).toBe(1);
      } finally {
        await Promise.allSettled([first, second]);
        await holder.end();
      }
    });

    it('back-pressure: no gate slot → 503 file-storage-busy; 200 staged photos on one device → 429 attachment-staging-limit', async () => {
      const releases = Array.from({ length: facade.uploadGate.slots }, () => facade.uploadGate.acquire());
      try {
        expect((await upload(ulid(), JPEG).expect(503)).body.code).toBe('file-storage-busy');
      } finally {
        for (const release of releases) release();
      }
      expect(facade.uploadGate.used).toBe(0);
      const { deviceId: busyId, deviceToken: busy } = await enroll('RP busy');
      await badgeIn(busy, operatorEmail);
      await sql`
        insert into attachments (id, tenant_id, purpose, status, source, client_ref, object_key, content_type, byte_size, sha256, width, height, device_id)
        select gen_random_uuid(), ${tenantId}, 'receipt-damage', 'staged', 'handheld',
               '01JZ' || lpad(g::text, 22, '0'), 'tenants/x/attachments/' || gen_random_uuid(), 'image/jpeg', 10, ${'a'.repeat(64)}, 1, 1, ${busyId}
        from generate_series(1, 200) g`;
      try {
        const limited = await upload(ulid(), JPEG, { token: busy }).expect(429);
        expect(limited.body.code).toBe('attachment-staging-limit');
      } finally {
        await sql`update attachments set status = 'discarded', purged_at = now() where tenant_id = ${tenantId} and device_id = ${busyId}`;
      }
    });
  });

  // ── the hash ───────────────────────────────────────────────────────────────

  describe('the grn.submit hash', () => {
    it('photoRefs is the line\'s LAST key, only when non-empty (golden); absent and [] hash as before', async () => {
      const occurredAt = '2026-10-19T06:00:00.000Z';
      const ref = ulid();
      const key = ulid();
      await receive(grnBody('ALFA', [line(sku('ALFA', 'A-1'), 2, { damagedQty: 1, damageReasonCode: 'wet', photoRefs: [ref] })], { occurredAt }), key).expect(201);
      const golden =
        `{"tenantId":"${tenantId}","deviceId":"${deviceId}","operatorUserId":"${operatorUserId}","warehouseId":"${wh}",` +
        `"poId":null,"blindReasonCode":"other","clientId":"${client('ALFA')}","occurredAt":"${occurredAt}",` +
        `"lines":[{"poLineId":null,"skuId":"${sku('ALFA', 'A-1')}","batchCode":null,"mfgDate":null,"qty":2,` +
        `"damagedQty":1,"damageReasonCode":"wet","photoRefs":["${ref}"]}]}`;
      expect(await payloadHashOf(key)).toBe(sha256(Buffer.from(golden, 'utf8')));
      // Without photos, and with [], the pre-2-5a shape (no photoRefs key).
      const plain =
        `{"tenantId":"${tenantId}","deviceId":"${deviceId}","operatorUserId":"${operatorUserId}","warehouseId":"${wh}",` +
        `"poId":null,"blindReasonCode":"other","clientId":"${client('ALFA')}","occurredAt":"${occurredAt}",` +
        `"lines":[{"poLineId":null,"skuId":"${sku('ALFA', 'A-1')}","batchCode":null,"mfgDate":null,"qty":2}]}`;
      for (const extra of [{}, { photoRefs: [] }]) {
        const k = ulid();
        await receive(grnBody('ALFA', [line(sku('ALFA', 'A-1'), 2, extra)], { occurredAt }), k).expect(201);
        expect(await payloadHashOf(k)).toBe(sha256(Buffer.from(plain, 'utf8')));
      }
    });
  });

  // ── review rows and Apply ──────────────────────────────────────────────────

  describe('review rows carry the refs; Apply binds them (A2, A3, A17)', () => {
    async function rejectedOp(opId: string): Promise<{ id: string; payload: Record<string, unknown> }> {
      return ((await sql`select id, payload from rejected_ops where tenant_id = ${tenantId} and op_id = ${opId}`) as unknown as { id: string; payload: Record<string, unknown> }[])[0]!;
    }

    it('a short-dated line goes to review with its refs; they stay staged (and the sweep keeps them); Apply attaches them', async () => {
      const ref = ulid();
      await upload(ref, JPEG).expect(201);
      const res = await receive(
        grnBody('EXP', [line(sku('EXP', 'E-B'), 2, { batchCode: 'B-SHORT', expiryDate: '2026-11-01', photoRefs: [ref] })]),
      ).expect(201);
      expect(res.body.goodsReceipt).toBeNull();
      const opId = res.body.refusedReceipt.shelfLifeReviewOpId as string;
      const row = await rejectedOp(opId);
      expect((row.payload.lines as Record<string, unknown>[])[0]!.photoRefs).toEqual([ref]);
      // The rejectedLines entry is unchanged (A3): no photoRefs there.
      expect(res.body.refusedReceipt.rejectedLines[0].photoRefs).toBeUndefined();
      expect((await rowsByRef(ref))[0]!.status).toBe('staged');

      // The sweep, run long after, keeps a staged photo an OPEN review row names.
      const aged = await facade.sweep(tenantId, new Date(Date.now() + 40 * 86_400_000));
      expect(aged.keptReferenced).toBeGreaterThanOrEqual(1);
      expect((await rowsByRef(ref))[0]!.status).toBe('staged');

      const applied = await http()
        .post(`${API}/${tenantId}/rejected-ops/${row.id}/resolve`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ decision: 'apply', note: 'Client accepts short-dated' })
        .expect(200);
      const grn = (applied.body.outcome as { snapshot: { goodsReceipt: { id: string; lines: { id: string }[] } } }).snapshot.goodsReceipt;
      expect((await rowsByRef(ref))[0]).toMatchObject({ status: 'attached', owner_parent_id: grn.id, owner_id: grn.lines[0]!.id });
    });

    it('once the review row is discarded, the sweep discards the staged photo it named (only OPEN rows keep a ref — C24)', async () => {
      const ref = ulid();
      await upload(ref, JPEG).expect(201);
      const res = await receive(
        grnBody('EXP', [line(sku('EXP', 'E-B'), 2, { batchCode: 'B-DISC', expiryDate: '2026-11-01', photoRefs: [ref] })]),
      ).expect(201);
      const row = await rejectedOp(res.body.refusedReceipt.shelfLifeReviewOpId as string);
      const future = new Date(Date.now() + 40 * 86_400_000);
      await facade.sweep(tenantId, future);
      expect((await rowsByRef(ref))[0]!.status).toBe('staged');
      await http()
        .post(`${API}/${tenantId}/rejected-ops/${row.id}/resolve`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ decision: 'discard' })
        .expect(200);
      await facade.sweep(tenantId, future);
      expect((await sql`select status from attachments where tenant_id = ${tenantId} and client_ref = ${ref}`)[0]!.status).toBe('discarded');
    });

    it('a device-uploaded grn.submit review row: Apply re-binds the device\'s staged photos (its device id)', async () => {
      const ref = ulid();
      await upload(ref, JPEG_2).expect(201);
      const opId = ulid();
      await http()
        .post(`${API}/${tenantId}/devices/sync-reports`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          rows: [
            {
              opId,
              opType: 'grn.submit',
              classification: 'rejected',
              problemCode: 'device-offline',
              problemDetail: 'Queued while offline',
              payload: grnBody('ALFA', [line(sku('ALFA', 'A-1'), 1, { photoRefs: [ref] })]),
              attribution: { deviceLabel: 'RP dock', operatorEmail },
              opEnqueuedAt: OCCURRED_AT,
              opOccurredAt: null,
            },
          ],
        })
        .expect(201);
      const row = await rejectedOp(opId);
      const applied = await http()
        .post(`${API}/${tenantId}/rejected-ops/${row.id}/resolve`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ decision: 'apply' })
        .expect(200);
      const grn = (applied.body.outcome as { snapshot: { goodsReceipt: { id: string } } }).snapshot.goodsReceipt;
      expect((await rowsByRef(ref))[0]).toMatchObject({ status: 'attached', owner_parent_id: grn.id });
    });

    it('a refused photo op reaches the review queue Discard-only, with its payload fields', async () => {
      const opId = ulid();
      await http()
        .post(`${API}/${tenantId}/devices/sync-reports`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          rows: [
            {
              opId,
              opType: 'receipt-photo.stage',
              classification: 'rejected',
              problemCode: 'attachment-type-unsupported',
              problemDetail: 'HEIC photos are not supported — export as JPEG.',
              payload: { ref: opId, capturedAt: OCCURRED_AT, grnOpId: ulid(), lineIndex: 1 },
              attribution: { deviceLabel: 'RP dock', operatorEmail },
              opEnqueuedAt: OCCURRED_AT,
              opOccurredAt: null,
            },
          ],
        })
        .expect(201);
      const listed = await http().get(`${API}/${tenantId}/rejected-ops`).query({ status: 'open', limit: 200 }).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      const entry = (listed.body.items as { opId: string; decisions: string[] }[]).find((item) => item.opId === opId)!;
      expect(entry.decisions).toEqual(['discard']);
      const apply = await http()
        .post(`${API}/${tenantId}/rejected-ops/${(await rejectedOp(opId)).id}/resolve`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ decision: 'apply' })
        .expect(409);
      expect(apply.body.code).toBe('decision-not-available');
    });
  });

  // ── the portal ─────────────────────────────────────────────────────────────

  describe('the client portal (A4)', () => {
    it('lists the client\'s receipts; a foreign or null-client GRN is the same 404; a removed photo is a bare placeholder', async () => {
      const ref = ulid();
      const grnA = await grnOf(grnBody('ALFA', [line(sku('ALFA', 'A-1'), 4, { damagedQty: 1, damageReasonCode: 'torn-packaging', photoRefs: [ref] })]));
      await upload(ref, JPEG).expect(201);
      const keep = await webAdd(grnA.id, grnA.lines[0]!.id, JPEG_2).expect(201);
      const attachmentId = (await rowsByRef(ref))[0]!.id;
      await remove(grnA.id, attachmentId, 'Duplicate of another photo').expect(200);
      const grnB = await grnOf(grnBody('BRAVO', [line(sku('BRAVO', 'B-1'), 1)]));

      const page = await http().get(`${API}/${tenantId}/portal/inbound/goods-receipts`).query({ limit: 100 }).set('Authorization', `Bearer ${portalA}`).expect(200);
      const ids = (page.body.items as { id: string }[]).map((item) => item.id);
      expect(ids).toContain(grnA.id);
      expect(ids).not.toContain(grnB.id);
      const rowA = (page.body.items as Record<string, unknown>[]).find((item) => item.id === grnA.id)!;
      expect(rowA).toMatchObject({ code: grnA.code, lineCount: 1, receivedTotal: 4, damagedTotal: 1, shortTotal: 0, photoCount: 1 });
      expect(Object.keys(rowA).sort()).toEqual(
        ['asnCode', 'code', 'createdAt', 'damagedTotal', 'id', 'lineCount', 'photoCount', 'poCode', 'receivedAt', 'receivedTotal', 'shortTotal', 'warehouseName'].sort(),
      );

      const detail = await http().get(`${API}/${tenantId}/portal/inbound/goods-receipts/${grnA.id}`).set('Authorization', `Bearer ${portalA}`).expect(200);
      const photos = detail.body.lines[0].photos as { id: string; status: string; url: string | null }[];
      expect(photos.map((photo) => [photo.id, photo.status, photo.url === null])).toEqual(
        expect.arrayContaining([
          [attachmentId, 'removed', true],
          [keep.body.attachment.id, 'attached', false],
        ]),
      );
      expect(JSON.stringify(detail.body)).not.toContain('Duplicate of another photo'); // never the reason
      expect(detail.body.lines[0]).toMatchObject({ lineNo: 1, qty: 4, damagedQty: 1, damageReasonCode: 'torn-packaging' });

      for (const [token, id] of [
        [portalA, grnB.id],
        [portalB, grnA.id],
        [portalA, uuidv7()],
      ] as const) {
        expect((await http().get(`${API}/${tenantId}/portal/inbound/goods-receipts/${id}`).set('Authorization', `Bearer ${token}`).expect(404)).body.code).toBe('not-found');
      }
      // A legacy unattributed receipt (no client) is invisible too.
      await sql`update goods_receipt_notes set client_id = null where id = ${grnB.id}`;
      expect((await http().get(`${API}/${tenantId}/portal/inbound/goods-receipts/${grnB.id}`).set('Authorization', `Bearer ${portalB}`).expect(404)).body.code).toBe('not-found');
      await sql`update goods_receipt_notes set client_id = ${client('BRAVO')} where id = ${grnB.id}`;
      // The operator routes refuse a portal session (the fence).
      expect((await listPhotos(grnA.id, portalA).expect(403)).body.code).toBe('role-denied');
    });
  });

  // ── RLS ────────────────────────────────────────────────────────────────────

  describe('RLS (wms_rls_probe)', () => {
    const PROBE_LOCK = 742105;

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
        await tx.unsafe('grant select, insert, update, delete on all tables in schema public to wms_rls_probe');
      });
    }

    it('the list query shape, app predicate removed: the tenant arm hides another tenant; the client arm hides another client (A27)', async () => {
      const grnA = await grnOf(grnBody('ALFA', [line(sku('ALFA', 'A-1'), 1, { photoRefs: [ulid()] })]));
      const grnB = await grnOf(grnBody('BRAVO', [line(sku('BRAVO', 'B-1'), 1, { photoRefs: [ulid()] })]));
      await ensureProbeRole();
      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const probe = postgres(url.toString(), { max: 1, onnotice: () => undefined });
      try {
        const visible = async (tenant: string, clientId: string | null, grnId: string): Promise<number> =>
          probe.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${tenant}, true)`;
            if (clientId !== null) await tx`select set_config('app.client_id', ${clientId}, true)`;
            const rows = await tx`select count(*)::int as n from attachments where owner_parent_id = ${grnId}`;
            return Number(rows[0]!.n);
          }) as Promise<number>;
        expect(await visible(tenantId, null, grnA.id)).toBe(1); // positive control
        expect(await visible(uuidv7(), null, grnA.id)).toBe(0); // the tenant arm
        expect(await visible(tenantId, client('ALFA'), grnA.id)).toBe(1);
        expect(await visible(tenantId, client('ALFA'), grnB.id)).toBe(0); // the client arm
        expect(await visible(tenantId, client('BRAVO'), grnB.id)).toBe(1);
      } finally {
        await probe.end();
      }
    });
  });

  // ── the sweep ──────────────────────────────────────────────────────────────

  describe('the retention sweep (A10, A11, A22)', () => {
    it('every arm: an old reservation and an unbound staged photo are discarded then purged; an old awaited one expires; a removed photo\'s bytes are purged after the age', async () => {
      const uploading = ulid();
      store.failPut = true;
      try {
        await upload(uploading, JPEG).expect(503);
      } finally {
        store.failPut = false;
      }
      const stagedRef = ulid();
      await upload(stagedRef, JPEG).expect(201);
      const awaitedRef = ulid();
      const grn = await grnOf(grnBody('ALFA', [line(sku('ALFA', 'A-2'), 1, { photoRefs: [awaitedRef] })]));
      const removedPhoto = (await webAdd(grn.id, grn.lines[0]!.id, JPEG_2).expect(201)).body.attachment.id as string;
      await remove(grn.id, removedPhoto, 'Blurred').expect(200);
      const removedKey = (await rowById(removedPhoto)).object_key!;
      const stagedRow = (await rowsByRef(stagedRef))[0]!;

      // Within the ages nothing moves.
      const early = await facade.sweep(tenantId, new Date(Date.now() + 30 * 60_000));
      expect(early.discardedUploading).toBe(0);
      expect((await rowsByRef(stagedRef))[0]!.status).toBe('staged');

      // Two hours on: the reservation (no object was put) is discarded and purged.
      await facade.sweep(tenantId, new Date(Date.now() + 2 * 3_600_000));
      const reservation = ((await sql`select * from attachments where tenant_id = ${tenantId} and upload_key = ${uploading}`) as unknown as AttachmentDbRow[])[0]!;
      expect(reservation.status).toBe('discarded');
      expect(reservation.purged_at).not.toBeNull();

      // 31 days on: staged → discarded (bytes deleted), awaited → expired, removed → purged.
      const later = await facade.sweep(tenantId, new Date(Date.now() + 31 * 86_400_000));
      expect(later.expired).toBeGreaterThanOrEqual(1);
      expect(await rowById(stagedRow.id)).toMatchObject({ status: 'discarded' });
      expect((await rowById(stagedRow.id)).purged_at).not.toBeNull();
      expect(store.deleted).toEqual(expect.arrayContaining([stagedRow.object_key, removedKey]));
      expect((await rowsByRef(awaitedRef))[0]!.status).toBe('expired');
      expect((await rowById(removedPhoto)).purged_at).not.toBeNull();
      const purgedAudit = (await sql`select actor_user_id, reference from audit_events where tenant_id = ${tenantId} and action = 'receipt_photo.purged' and target_id = ${removedPhoto}`) as unknown as {
        actor_user_id: string;
        reference: string | null;
      }[];
      expect(purgedAudit).toEqual([{ actor_user_id: '01900000-0000-7000-8000-000000000000', reference: null }]);
      // A purged removed photo's list entry is unchanged: removed, no URL.
      expect(((await listPhotos(grn.id).expect(200)).body.photos as { id: string; url: string | null }[]).find((photo) => photo.id === removedPhoto)!.url).toBeNull();
    });

    it('a failed delete leaves purged_at null and retries next tick; two sweepers purge each row once', async () => {
      const ref = ulid();
      await upload(ref, JPEG).expect(201);
      const row = (await rowsByRef(ref))[0]!;
      await sql`update attachments set status = 'discarded' where id = ${row.id}`;
      store.failDelete = true;
      try {
        const failed = await facade.sweep(tenantId, new Date());
        expect(failed.deleteFailures).toBeGreaterThanOrEqual(1);
      } finally {
        store.failDelete = false;
      }
      expect((await rowById(row.id)).purged_at).toBeNull();
      const [a, b] = await Promise.all([facade.sweep(tenantId, new Date()), facade.sweep(tenantId, new Date())]);
      expect(a.purged + b.purged).toBeGreaterThanOrEqual(1);
      expect((await rowById(row.id)).purged_at).not.toBeNull();
      expect(Number((await sql`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and action = 'receipt_photo.purged' and target_id = ${row.id}`)[0]!.n)).toBe(1);
    });

    it('the worker discovers tenants on the auth database and drives one sweep each (tick once, for the plumbing)', async () => {
      const ref = ulid();
      await upload(ref, JPEG).expect(201);
      await sql`update attachments set status = 'discarded' where tenant_id = ${tenantId} and client_ref = ${ref}`;
      const worker = app.get(AttachmentSweepWorker);
      expect(await worker.tick()).toContain(tenantId);
      expect((await rowsByRef(ref))[0]!.purged_at).not.toBeNull();
    });

    it('discovery finds a tenant by EACH arm alone: an old reservation, an old staged or awaited photo, a removed photo past the age (C23)', async () => {
      const worker = app.get(AttachmentSweepWorker);
      // A fresh tenant per arm, so only that arm can discover it.
      const arms: { name: string; seed: (t: string) => Promise<string>; after: string }[] = [
        { name: 'uploading', after: 'discarded', seed: async (t) => insertRow(t, { status: 'uploading', upload_key: ulid(), age: `interval '2 hours'` }) },
        { name: 'staged', after: 'discarded', seed: async (t) => insertRow(t, { status: 'staged', client_ref: ulid(), age: `interval '31 days'` }) },
        { name: 'awaited', after: 'expired', seed: async (t) => insertRow(t, { status: 'awaited', client_ref: ulid(), owned: true, objectless: true, age: `interval '31 days'` }) },
        { name: 'removed', after: 'removed', seed: async (t) => insertRow(t, { status: 'removed', owned: true, removedAge: `interval '31 days'` }) },
      ];
      for (const arm of arms) {
        const t = uuidv7();
        const id = await arm.seed(t);
        expect(await worker.tick()).toContain(t);
        const row = (await sql`select status, purged_at from attachments where id = ${id}`)[0] as { status: string; purged_at: Date | null };
        expect([arm.name, row.status]).toEqual([arm.name, arm.after]);
        if (arm.name !== 'awaited') expect(row.purged_at).not.toBeNull();
      }
    });

    async function insertRow(
      t: string,
      shape: { status: string; client_ref?: string; upload_key?: string; owned?: boolean; objectless?: boolean; age?: string; removedAge?: string },
    ): Promise<string> {
      const id = uuidv7();
      const objectless = shape.objectless === true;
      await sql.unsafe(
        `insert into attachments (id, tenant_id, purpose, status, source, device_id, client_ref, upload_key, upload_hash, raw_sha256,
           owner_type, owner_id, owner_parent_id, object_key, content_type, byte_size, sha256, width, height,
           removed_by, removed_at, removed_reason, created_at, updated_at)
         values ($1, $2, 'receipt-damage', $3, 'handheld', $4, $5, $6, $7, $7,
           $8, $9, $10, $11, $12, $13, $14, $15, $15,
           $16, ${shape.removedAge === undefined ? 'null' : `now() - ${shape.removedAge}`}, $17,
           now() - ${shape.age ?? `interval '0 seconds'`}, now() - ${shape.age ?? `interval '0 seconds'`})`,
        [
          id, t, shape.status, uuidv7(), shape.client_ref ?? null, shape.upload_key ?? null, 'b'.repeat(64),
          shape.owned === true ? 'goods_receipt_line' : null, shape.owned === true ? uuidv7() : null, shape.owned === true ? uuidv7() : null,
          objectless ? null : `tenants/${t}/attachments/${id}`, objectless ? null : 'image/jpeg', objectless ? null : 10, objectless ? null : 'a'.repeat(64), objectless ? null : 1,
          shape.status === 'removed' ? uuidv7() : null, shape.status === 'removed' ? 'Blurred' : null,
        ],
      );
      return id;
    }

    it('the referenced-ref keep reads rejected_ops through the jsonb path predicate (EXPLAIN of the real query)', async () => {
      const plan = (await sql.unsafe(`
        explain select a.id, exists (
          select 1 from rejected_ops r
          where r.tenant_id = a.tenant_id and r.status = 'open'
            and jsonb_path_exists(r.payload, '$.lines[*].photoRefs[*] ? (@ == $ref)', jsonb_build_object('ref', a.client_ref))
        ) as referenced
        from attachments a
        where a.tenant_id = '${tenantId}' and a.status = 'staged' and a.created_at < now()
        order by a.created_at, a.id
        limit 100
        for update of a skip locked`)) as unknown as { 'QUERY PLAN': string }[];
      const text = plan.map((row) => row['QUERY PLAN']).join('\n');
      expect(text).toContain('jsonb_path_exists');
      expect(text).toMatch(/attachments/);
    });
  });

  // ── vocabularies and the contract ──────────────────────────────────────────

  describe('vocabularies and the OpenAPI contract', () => {
    it('the TS tuples equal the migration CHECKs', async () => {
      const checks = (await sql`
        select conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'attachments'::regclass and contype = 'c'`) as unknown as { conname: string; def: string }[];
      const literals = (name: string): string[] => {
        const def = checks.find((check) => check.conname === name)!.def;
        return [...def.matchAll(/'([^']+)'::text/g)].map((match) => match[1]!);
      };
      expect(literals('attachments_status_check').sort()).toEqual([...ATTACHMENT_STATUSES].sort());
      expect(literals('attachments_source_check').sort()).toEqual([...ATTACHMENT_SOURCES].sort());
      expect(literals('attachments_purpose_check').sort()).toEqual([...ATTACHMENT_PURPOSES].sort());
      // Story 4-4a (0116) — four more: doc_kind, page_count, purpose_owner, label_is_pdf.
      expect(checks.length).toBe(25);
    });

    it('the OpenAPI document lists the six new routes with their methods', () => {
      const doc = JSON.parse(readFileSync(join(__dirname, '..', 'openapi', 'openapi.json'), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
      const path = (p: string) => doc.paths[`/api/v1/tenants/{tenantId}${p}`] ?? doc.paths[`/tenants/{tenantId}${p}`] ?? {};
      expect(Object.keys(path('/receiving/receipt-photos'))).toEqual(['post']);
      expect(Object.keys(path('/receiving/goods-receipts/{grnId}/photos'))).toEqual(['get']);
      expect(Object.keys(path('/receiving/goods-receipts/{grnId}/lines/{lineId}/photos'))).toEqual(['post']);
      expect(Object.keys(path('/receiving/goods-receipts/{grnId}/photos/{attachmentId}/remove'))).toEqual(['post']);
      expect(Object.keys(path('/portal/inbound/goods-receipts'))).toEqual(['get']);
      expect(Object.keys(path('/portal/inbound/goods-receipts/{grnId}'))).toEqual(['get']);
    });
  });

  // ── race helpers ───────────────────────────────────────────────────────────

  /**
   * Waits until `min` requests are parked behind the holder — directly on the
   * ref advisory lock, or transitively (the second request of the same device
   * parks on the device row the first holds while it waits on the advisory).
   */
  async function waitAdvisoryParked(holderPid: number, min: number): Promise<void> {
    const probe = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const waiting = (await probe`
          select a.pid, a.wait_event, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
          where a.wait_event_type = 'Lock' and a.state = 'active'`) as unknown as { pid: number; wait_event: string; blockers: number[] }[];
        const chain = new Set<number>([holderPid]);
        const direct = waiting.filter((row) => row.wait_event === 'advisory' && row.blockers.includes(holderPid)).length;
        for (let grew = true; grew; ) {
          grew = false;
          for (const row of waiting) {
            if (!chain.has(row.pid) && row.blockers.some((pid) => chain.has(pid))) {
              chain.add(row.pid);
              grew = true;
            }
          }
        }
        if (direct >= 1 && chain.size - 1 >= min) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`fewer than ${min} request(s) parked behind the ref advisory lock`);
    } finally {
      await probe.end();
    }
  }

  async function waitRowParked(holderPid: number, min: number): Promise<void> {
    const probe = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const rows = (await probe`
          select count(*)::int as n from pg_stat_activity a
          where a.wait_event_type = 'Lock' and ${holderPid} = any(pg_blocking_pids(a.pid))`) as unknown as { n: number }[];
        if (Number(rows[0]!.n) >= min) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`fewer than ${min} request(s) parked on the line lock`);
    } finally {
      await probe.end();
    }
  }
});
