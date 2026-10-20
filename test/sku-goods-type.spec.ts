import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { CatalogFacade } from '../src/modules/catalog/catalog.facade';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';
import { toMilli } from '../src/shared/primitives/quantity';
import {
  ALLERGENS,
  DG_CLASSES,
  DG_CLASSES_WITHOUT_PACKING_GROUP,
  DG_HAZARD_MAP,
  DG_PACKING_GROUPS,
  DRUG_SCHEDULES,
  FOOD_CATEGORIES,
} from '../src/shared/primitives/goods-type';
import { HAZARD_CLASSES } from '../src/shared/primitives/hazard';
import { spawnSync } from 'node:child_process';
import { eq, sql as dsql } from 'drizzle-orm';
import type { Database } from '../src/shared/db/db';
import { skus as skusTable } from '../src/shared/db/schema';
import {
  EMPTY_PROFILE_SQL,
  SEGREGATION_PROFILE_COLUMNS,
  isEmptyProfile,
  profileOf,
} from '../src/shared/primitives/segregation';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { mintSignIn } from './support/sign-in';
import { expectAuditRow, seededIdempotencyKey } from './support/audit-guard';
import { testAddress } from './support/shipment-address';

// Story 1-6a — SKU goods-type attributes: drug schedules, food category and
// allergens, dangerous goods (UN number, class, subsidiaries, packing group),
// high value, fragile, the stack limit. Every row of the spec's I/O matrix
// has a test here; the rule set itself is pinned rule by rule in
// `src/shared/primitives/goods-type.spec.ts`. One single-client tenant (the
// create defaults to its `self` client).
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;

jest.setTimeout(120_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

interface SkuBody {
  id: string;
  code: string;
  hazardClass: string | null;
  drugSchedules: string[];
  foodCategory: string | null;
  allergens: string[];
  dgUnNumber: string | null;
  dgClass: string | null;
  dgSubsidiaryClasses: string[];
  dgPackingGroup: string | null;
  highValue: boolean;
  fragile: boolean;
  maxStackLayers: number | null;
  [key: string]: unknown;
}

const GOODS_DEFAULTS = {
  drugSchedules: [],
  foodCategory: null,
  allergens: [],
  dgUnNumber: null,
  dgClass: null,
  dgSubsidiaryClasses: [],
  dgPackingGroup: null,
  highValue: false,
  fragile: false,
  maxStackLayers: null,
};

describe('story 1-6a: SKU goods-type attributes (e2e)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let tenantId: string;
  let ownerToken: string;
  let ownerUserId: string;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('sku_goods_type');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Goods Type Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerUserId = registered.body.owner.id as string;
    ownerToken = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;
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

  function createSku(body: Record<string, unknown>, key = ulid()): request.Test {
    return http()
      .post(`${API}/${tenantId}/catalog/skus`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function patchSku(skuId: string, body: Record<string, unknown>, key = ulid()): request.Test {
    return http()
      .patch(`${API}/${tenantId}/catalog/skus/${skuId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  let seq = 0;
  function baseBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
    seq += 1;
    return {
      code: `GT-${seq}-${ulid().slice(20)}`,
      name: `Goods ${seq}`,
      uom: 'each',
      gstRate: 1800,
      batchTracked: false,
      serialTracked: false,
      catchWeightTracked: false,
      ...extra,
    };
  }

  async function newSku(extra: Record<string, unknown> = {}): Promise<SkuBody> {
    return (await createSku(baseBody(extra)).expect(201)).body.sku as SkuBody;
  }

  async function stored(skuId: string): Promise<Record<string, unknown>> {
    const rows = await sql`
      select hazard_class, drug_schedules, food_category, allergens, dg_un_number, dg_class,
             dg_subsidiary_classes, dg_packing_group, high_value, fragile, max_stack_layers
        from skus where id = ${skuId}`;
    return rows[0]!;
  }

  function expectProblem(res: request.Response, status: number, code: string): void {
    expect({ status: res.status, code: (res.body as { code?: string }).code }).toEqual({ status, code });
  }

  function importCsv(header: string[], rows: string[][], key = ulid()): request.Test {
    const csv = [header.join(','), ...rows.map((row) => row.join(','))].join('\n');
    return http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, key)
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' });
  }

  async function skuByCode(code: string): Promise<SkuBody> {
    const rows = await sql<{ id: string }[]>`select id from skus where tenant_id = ${tenantId} and code = ${code}`;
    const res = await http()
      .get(`${API}/${tenantId}/catalog/skus`)
      .query({ limit: 200 })
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    return (res.body.items as SkuBody[]).find((item) => item.id === rows[0]!.id)!;
  }

  // ── vocabularies and the contract ──────────────────────────────────────────

  describe('vocabularies, CHECKs and the contract', () => {
    async function literals(conname: string): Promise<string[]> {
      const def = (await sql<{ def: string }[]>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${conname}`)[0]!.def;
      return [...new Set([...def.matchAll(/'([^']+)'::text/g)].map((match) => match[1]!))].sort();
    }

    it('every tuple is exactly its named constraint\'s vocabulary', async () => {
      expect(await literals('skus_drug_schedules_check')).toEqual([...DRUG_SCHEDULES].sort());
      expect(await literals('skus_food_category_check')).toEqual([...FOOD_CATEGORIES].sort());
      expect(await literals('skus_allergens_check')).toEqual([...ALLERGENS].sort());
      expect(await literals('skus_dg_class_check')).toEqual([...DG_CLASSES].sort());
      expect(await literals('skus_dg_subsidiary_classes_check')).toEqual([...DG_CLASSES].sort());
      expect(await literals('skus_dg_packing_group_check')).toEqual([...DG_PACKING_GROUPS].sort());
      expect(await literals('skus_dg_packing_group_pairing')).toEqual([...DG_CLASSES_WITHOUT_PACKING_GROUP].sort());
    });

    it('the derivation backstop refuses a mapped class with another hazard, and class 8 with a non-corrosive', async () => {
      const sku = await newSku();
      await expect(sql`update skus set dg_un_number = '1203', dg_class = '3', hazard_class = 'toxic' where id = ${sku.id}`).rejects.toMatchObject({
        constraint_name: 'skus_dg_hazard_derived',
      });
      await expect(sql`update skus set dg_un_number = '1203', dg_class = '3', hazard_class = null where id = ${sku.id}`).rejects.toMatchObject({
        constraint_name: 'skus_dg_hazard_derived',
      });
      await expect(sql`update skus set dg_un_number = '1830', dg_class = '8', hazard_class = 'toxic' where id = ${sku.id}`).rejects.toMatchObject({
        constraint_name: 'skus_dg_hazard_derived',
      });
      await expect(sql`update skus set allergens = '{milk}' where id = ${sku.id}`).rejects.toMatchObject({
        constraint_name: 'skus_allergens_food_pairing',
      });
    });

    it('skus_dg_hazard_derived agrees with DG_HAZARD_MAP for every mapped class: the mapped value is admitted, every other class refused', async () => {
      const sku = await newSku();
      const entries = Object.entries(DG_HAZARD_MAP);
      expect(entries).toHaveLength(12);
      for (const [dgClass, mapped] of entries) {
        await sql`update skus set dg_un_number = '1203', dg_class = ${dgClass}, hazard_class = ${mapped} where id = ${sku.id}`;
        expect(await stored(sku.id)).toMatchObject({ dg_class: dgClass, hazard_class: mapped });
        for (const other of [...HAZARD_CLASSES.filter((h) => h !== mapped), null]) {
          await expect(
            sql`update skus set dg_un_number = '1203', dg_class = ${dgClass}, hazard_class = ${other} where id = ${sku.id}`,
          ).rejects.toMatchObject({ constraint_name: 'skus_dg_hazard_derived' });
        }
      }
      await sql`update skus set dg_un_number = null, dg_class = null, hazard_class = null where id = ${sku.id}`;
    });

    it('the committed OpenAPI carries the fields, the snapshot DG arm and the two new codes', () => {
      const committed = JSON.parse(readFileSync(resolve(process.cwd(), 'openapi/openapi.json'), 'utf8')) as {
        paths: Record<string, Record<string, { responses: Record<string, { description: string }> }>>;
        components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
      };
      const fields = Object.keys(GOODS_DEFAULTS);
      expect(committed.components.schemas['SkuResponse']!.required).toEqual(expect.arrayContaining(fields));
      for (const dto of ['CreateSkuDto', 'PatchSkuDto']) {
        expect(Object.keys(committed.components.schemas[dto]!.properties!)).toEqual(expect.arrayContaining(fields));
      }
      expect(Object.keys(committed.components.schemas['CatalogSnapshotSkuDto']!.properties!)).toEqual(
        expect.arrayContaining(['fragile', 'highValue', 'maxStackLayers', 'dg']),
      );
      expect(Object.keys(committed.components.schemas['CatalogSnapshotDgDto']!.properties!).sort()).toEqual([
        'class',
        'packingGroup',
        'subsidiaryClasses',
        'unNumber',
      ]);
      const create = committed.paths['/tenants/{tenantId}/catalog/skus']!['post']!.responses['400']!.description;
      const edit = committed.paths['/tenants/{tenantId}/catalog/skus/{skuId}']!['patch']!.responses['400']!.description;
      for (const text of [create, edit]) {
        expect(text).toContain('dg-hazard-mismatch');
        expect(text).toContain('dg-hazard-required');
      }
    });
  });

  // ── the I/O matrix: food, drug, flags, stack ───────────────────────────────

  describe('food, drug, flags and the stack limit', () => {
    it('Food: allergens are sorted and de-duplicated', async () => {
      const sku = await newSku();
      const key = ulid();
      const res = await patchSku(sku.id, { foodCategory: 'dairy', allergens: ['milk', 'eggs', 'milk'] }, key).expect(200);
      expect(res.body).toMatchObject({ foodCategory: 'dairy', allergens: ['eggs', 'milk'] });
      expect(await stored(sku.id)).toMatchObject({ food_category: 'dairy', allergens: ['eggs', 'milk'] });
      await expectAuditRow({ tenantId, key, action: 'sku.edited', targetType: 'sku', targetId: sku.id, actorUserId: ownerUserId });
    });

    it('Food cleared: non-food with stored allergens is refused naming allergens; sending [] with it clears', async () => {
      const sku = await newSku({ foodCategory: 'dairy', allergens: ['milk'] });
      const refused = await patchSku(sku.id, { foodCategory: 'non-food' }).expect(400);
      expectProblem(refused, 400, 'validation-failed');
      expect(String(refused.body.detail)).toContain('allergens');
      expect(await stored(sku.id)).toMatchObject({ food_category: 'dairy', allergens: ['milk'] });
      const cleared = await patchSku(sku.id, { foodCategory: 'non-food', allergens: [] }).expect(200);
      expect(cleared.body).toMatchObject({ foodCategory: 'non-food', allergens: [] });
    });

    it('Drug: several schedules, sorted', async () => {
      const sku = await newSku();
      const res = await patchSku(sku.id, { drugSchedules: ['H', 'C'] }).expect(200);
      expect(res.body.drugSchedules).toEqual(['C', 'H']);
      expect(await stored(sku.id)).toMatchObject({ drug_schedules: ['C', 'H'] });
    });

    it('NOT NULL null: fragile, highValue and the three arrays refuse an explicit null (400, nothing written)', async () => {
      const sku = await newSku({ fragile: true });
      for (const body of [{ fragile: null }, { highValue: null }, { allergens: null }, { drugSchedules: null }, { dgSubsidiaryClasses: null }]) {
        const res = await patchSku(sku.id, body).expect(400);
        expectProblem(res, 400, 'validation-failed');
        expect(String(res.body.detail)).toContain(Object.keys(body)[0]!);
      }
      expectProblem(await createSku(baseBody({ highValue: null })).expect(400), 400, 'validation-failed');
      expect(await stored(sku.id)).toMatchObject({ fragile: true, allergens: [] });
    });

    it('Stack: 0 and 101 are refused; 1 is stored; null clears', async () => {
      const sku = await newSku();
      expectProblem(await patchSku(sku.id, { maxStackLayers: 0 }).expect(400), 400, 'validation-failed');
      expectProblem(await patchSku(sku.id, { maxStackLayers: 101 }).expect(400), 400, 'validation-failed');
      expect((await patchSku(sku.id, { maxStackLayers: 1 }).expect(200)).body.maxStackLayers).toBe(1);
      expect((await patchSku(sku.id, { maxStackLayers: null }).expect(200)).body.maxStackLayers).toBeNull();
    });

    it('flags and every field round-trip through the create, the list and the edit', async () => {
      const sku = await newSku({ highValue: true, fragile: true, maxStackLayers: 4, drugSchedules: ['NDPS', 'H1'] });
      expect(sku).toMatchObject({ highValue: true, fragile: true, maxStackLayers: 4, drugSchedules: ['H1', 'NDPS'] });
      const listed = await skuByCode(sku.code);
      expect(listed).toMatchObject({ highValue: true, fragile: true, maxStackLayers: 4, drugSchedules: ['H1', 'NDPS'], hazardClass: null });
      const off = await patchSku(sku.id, { highValue: false }).expect(200);
      expect(off.body).toMatchObject({ highValue: false, fragile: true });
    });

    it('a SKU with no goods-type data reads every default', async () => {
      const sku = await newSku();
      expect(sku).toMatchObject(GOODS_DEFAULTS);
    });
  });

  // ── the I/O matrix: DG and the derived hazard class ────────────────────────

  describe('dangerous goods and the derived hazard class (decision 7)', () => {
    it('DG derives: the UN prefix is stripped and the class replaces a stored hazard', async () => {
      const sku = await newSku({ hazardClass: 'toxic' });
      const res = await patchSku(sku.id, { dgUnNumber: 'un1203', dgClass: '3', dgPackingGroup: 'II' }).expect(200);
      expect(res.body).toMatchObject({ dgUnNumber: '1203', dgClass: '3', dgPackingGroup: 'II', hazardClass: 'flammable' });
      expect(await stored(sku.id)).toMatchObject({ dg_un_number: '1203', hazard_class: 'flammable' });
    });

    it('DG mismatch: a different class or an explicit null beside a mapped class is 400 dg-hazard-mismatch, nothing written', async () => {
      const sku = await newSku();
      expectProblem(await patchSku(sku.id, { dgClass: '3', dgUnNumber: '1203', hazardClass: 'toxic' }).expect(400), 400, 'dg-hazard-mismatch');
      expectProblem(await patchSku(sku.id, { dgClass: '3', dgUnNumber: '1203', hazardClass: null }).expect(400), 400, 'dg-hazard-mismatch');
      expect(await stored(sku.id)).toMatchObject({ dg_class: null, hazard_class: null });
      // Equal to the derived value is accepted.
      expect((await patchSku(sku.id, { dgClass: '3', dgUnNumber: '1203', hazardClass: 'flammable' }).expect(200)).body.hazardClass).toBe('flammable');
    });

    it('Class 8: no stored corrosive and no previous class 8 → 400 dg-hazard-required; explicit null stores none', async () => {
      const sku = await newSku();
      expectProblem(await patchSku(sku.id, { dgClass: '8', dgUnNumber: '1830' }).expect(400), 400, 'dg-hazard-required');
      expect(await stored(sku.id)).toMatchObject({ dg_class: null });
      const none = await patchSku(sku.id, { dgClass: '8', dgUnNumber: '1830', hazardClass: null }).expect(200);
      expect(none.body).toMatchObject({ dgClass: '8', hazardClass: null });
      // DG class unchanged (8, none) — an unrelated edit keeps none.
      expect((await patchSku(sku.id, { name: 'still none' }).expect(200)).body.hazardClass).toBeNull();
      expectProblem(await patchSku(sku.id, { hazardClass: 'toxic' }).expect(400), 400, 'dg-hazard-mismatch');
    });

    it('Class 8 kept: a stored corrosive survives an unrelated edit and a class-8 re-send', async () => {
      const sku = await newSku({ dgClass: '8', dgUnNumber: '1789', hazardClass: 'corrosive-acid' });
      expect(sku.hazardClass).toBe('corrosive-acid');
      expect((await patchSku(sku.id, { name: 'x' }).expect(200)).body.hazardClass).toBe('corrosive-acid');
      expect((await patchSku(sku.id, { dgPackingGroup: 'II' }).expect(200)).body.hazardClass).toBe('corrosive-acid');
      // A stored corrosive also carries INTO class 8 from no DG class.
      const base = await newSku({ hazardClass: 'corrosive-base' });
      expect((await patchSku(base.id, { dgClass: '8', dgUnNumber: '1824' }).expect(200)).body.hazardClass).toBe('corrosive-base');
    });

    it('Mapped → unmapped: the stored hazard class stays', async () => {
      const sku = await newSku({ dgClass: '3', dgUnNumber: '1203', dgPackingGroup: 'II' });
      expect(sku.hazardClass).toBe('flammable');
      const res = await patchSku(sku.id, { dgClass: '9', dgUnNumber: '3480', dgPackingGroup: null }).expect(200);
      expect(res.body).toMatchObject({ dgClass: '9', dgUnNumber: '3480', dgPackingGroup: null, hazardClass: 'flammable' });
      // Clearing the DG fields keeps it too.
      const cleared = await patchSku(sku.id, { dgClass: null, dgUnNumber: null }).expect(200);
      expect(cleared.body).toMatchObject({ dgClass: null, hazardClass: 'flammable' });
    });

    it('Hazard-only PATCH: judged against the stored DG class', async () => {
      const sku = await newSku({ dgClass: '3', dgUnNumber: '1203' });
      expectProblem(await patchSku(sku.id, { hazardClass: 'gas' }).expect(400), 400, 'dg-hazard-mismatch');
      expectProblem(await patchSku(sku.id, { hazardClass: null }).expect(400), 400, 'dg-hazard-mismatch');
      expect(await stored(sku.id)).toMatchObject({ hazard_class: 'flammable' });
    });

    it('Subsidiary: equal to the primary is refused; two distinct ones are stored sorted', async () => {
      const sku = await newSku();
      const refused = await patchSku(sku.id, { dgClass: '3', dgUnNumber: '1230', dgSubsidiaryClasses: ['6.1', '3'] }).expect(400);
      expectProblem(refused, 400, 'validation-failed');
      expect(String(refused.body.detail)).toContain('dgSubsidiaryClasses');
      const ok = await patchSku(sku.id, { dgClass: '3', dgUnNumber: '1230', dgSubsidiaryClasses: ['8', '6.1'] }).expect(200);
      expect(ok.body.dgSubsidiaryClasses).toEqual(['6.1', '8']);
    });

    it('Pairing: a UN number without a class, and a packing group on class 2.1, are refused', async () => {
      const sku = await newSku();
      expectProblem(await patchSku(sku.id, { dgUnNumber: '1203' }).expect(400), 400, 'validation-failed');
      const pg = await patchSku(sku.id, { dgClass: '2.1', dgUnNumber: '1950', dgPackingGroup: 'II' }).expect(400);
      expectProblem(pg, 400, 'validation-failed');
      expect(String(pg.body.detail)).toContain('dgPackingGroup');
      // Clearing the class alone leaves the UN number orphaned — refused against the MERGED state.
      const dg = await newSku({ dgClass: '3', dgUnNumber: '1203' });
      const orphan = await patchSku(dg.id, { dgClass: null }).expect(400);
      expectProblem(orphan, 400, 'validation-failed');
      // The detail names what to clear, not only what is missing.
      expect(orphan.body.detail).toBe(
        'A dangerous good needs both its UN number and its DG class — dgClass is missing. Set dgClass, or clear dgUnNumber (and dgPackingGroup and dgSubsidiaryClasses) to stop marking the SKU a dangerous good.',
      );
      expect((await patchSku(dg.id, { dgClass: null, dgUnNumber: null }).expect(200)).body.dgClass).toBeNull();
    });

    it('Create: an absent hazard derives; class 8 must name its choice; null is explicit none', async () => {
      expect((await newSku({ dgClass: '2.1', dgUnNumber: '1950' })).hazardClass).toBe('gas');
      expectProblem(await createSku(baseBody({ dgClass: '8', dgUnNumber: '1830' })).expect(400), 400, 'dg-hazard-required');
      expect((await newSku({ dgClass: '8', dgUnNumber: '1830', hazardClass: null })).hazardClass).toBeNull();
      expectProblem(await createSku(baseBody({ dgClass: '6.1', dgUnNumber: '1230', hazardClass: 'flammable' })).expect(400), 400, 'dg-hazard-mismatch');
      // An unmapped class keeps the requested class.
      expect((await newSku({ dgClass: '9', dgUnNumber: '3480', hazardClass: 'toxic' })).hazardClass).toBe('toxic');
    });

    it('Derived blocked: a DG class deriving explosive beside a classed binmate is 409 hazard-segregation-conflict', async () => {
      const warehouseId = (
        await http()
          .post(`${API}/${tenantId}/warehouses`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ origin: testAddress(), code: `GT-${ulid().slice(10, 16).toUpperCase()}`, name: `Goods Depot ${ulid()}` })
          .expect(201)
      ).body.id as string;
      const zoneId = (
        await http()
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code: 'A', name: 'Aisle A' })
          .expect(201)
      ).body.id as string;
      const binId = (
        await http()
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code: 'A-01', capacity: 100, type: 'shelf' })
          .expect(201)
      ).body.id as string;
      const sku = await newSku();
      const binmate = await newSku({ hazardClass: 'toxic' });
      for (const id of [sku.id, binmate.id]) {
        await sql`insert into stock_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, quantity)
                  values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${id}, ${binId}, ${toMilli(1)})`;
      }
      const res = await patchSku(sku.id, { dgClass: '1.1', dgUnNumber: '0004' }).expect(409);
      expectProblem(res, 409, 'hazard-segregation-conflict');
      expect(String(res.body.detail)).toContain('explosive');
      expect(String(res.body.detail)).toContain(binmate.code);
      expect(await stored(sku.id)).toMatchObject({ dg_class: null, hazard_class: null });
      // A class deriving nothing over the same stock edits freely (no derived hazard, no guard).
      expect((await patchSku(sku.id, { dgClass: '9', dgUnNumber: '3480' }).expect(200)).body.hazardClass).toBeNull();
    });
  });

  // ── idempotency (decision 10) ──────────────────────────────────────────────

  describe('canonical hashing and replays', () => {
    it('Idempotency: the same key with allergens reordered, or UN1203 vs 1203, replays', async () => {
      const sku = await newSku({ foodCategory: 'dairy' });
      const key = ulid();
      const first = await patchSku(sku.id, { allergens: ['milk', 'eggs'] }, key).expect(200);
      const replay = await patchSku(sku.id, { allergens: ['eggs', 'milk', 'milk'] }, key).expect(200);
      expect(replay.body).toEqual(first.body);

      const dgKey = ulid();
      const dgSku = await newSku();
      const a = await patchSku(dgSku.id, { dgClass: '3', dgUnNumber: 'UN1203' }, dgKey).expect(200);
      const b = await patchSku(dgSku.id, { dgClass: '3', dgUnNumber: '1203' }, dgKey).expect(200);
      expect(b.body).toEqual(a.body);

      const createKey = ulid();
      const body = baseBody({ dgClass: '3', dgUnNumber: 'un1203', drugSchedules: ['H', 'C'] });
      const c1 = await createSku(body, createKey).expect(201);
      const c2 = await createSku({ ...body, dgUnNumber: '1203', drugSchedules: ['C', 'H', 'C'] }, createKey).expect(201);
      expect(c2.body).toEqual(c1.body);
    });

    it('Old create key: a body without goods-type keys hashes byte for byte as before 1-6a (golden)', async () => {
      const key = ulid();
      const body = baseBody();
      const created = await createSku(body, key).expect(201);
      // The pre-1-6a fingerprint, written out key by key — an always-present
      // goods-type key would change it and fail here.
      const legacyHash = hashCommandPayload({
        command: 'sku.create',
        tenantId,
        code: body['code'],
        name: body['name'],
        uom: 'each',
        gstRateBps: 1800,
        hsn: null,
        barcode: null,
        batchTracked: false,
        serialTracked: false,
        catchWeightTracked: false,
        weightGrams: null,
        lengthMm: null,
        widthMm: null,
        heightMm: null,
        countryOfOrigin: null,
        storageClass: null,
        hazardClass: null,
        abcClass: null,
        reorderPoint: null,
        reorderQty: null,
        shelfLifeDays: null,
        levels: [],
        barcodes: [],
      });
      const row = (await sql<{ payload_hash: string }[]>`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)[0]!;
      expect(row.payload_hash).toBe(legacyHash);
      expect((await createSku(body, key).expect(201)).body).toEqual(created.body);
    });

    it('Replay: a pre-1-6a stored SKU response serves [], null and false', async () => {
      const sku = await newSku();
      const key = seededIdempotencyKey(tenantId, ulid());
      const hash = hashCommandPayload({ tenantId, skuId: sku.id, name: 'Legacy goods' });
      const legacy: Record<string, unknown> = { ...sku, name: 'Legacy goods' };
      for (const field of Object.keys(GOODS_DEFAULTS)) delete legacy[field];
      await sql`insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot)
        values (${uuidv7()}, ${tenantId}, ${key}, ${hash}, ${sql.json(legacy as never)})`;
      const res = await patchSku(sku.id, { name: 'Legacy goods' }, key).expect(200);
      expect(res.body).toMatchObject({ ...GOODS_DEFAULTS, name: 'Legacy goods' });
    });
  });

  // ── the import ─────────────────────────────────────────────────────────────

  describe('the catalog import', () => {
    const HEADER = [
      'sku_code', 'name', 'uom', 'gst_rate', 'hazard_class',
      'drug_schedules', 'food_category', 'allergens', 'dg_un_number', 'dg_class',
      'dg_subsidiary_classes', 'dg_packing_group', 'high_value', 'fragile', 'max_stack_layers',
    ];
    // sku_code, hazard_class, drug, food, allergens, un, class, subs, pg, high, fragile, stack
    function row(code: string, cells: Partial<Record<string, string>>): string[] {
      return [
        code, `Import ${code}`, 'each', '1800', cells['hazard_class'] ?? '',
        cells['drug_schedules'] ?? '', cells['food_category'] ?? '', cells['allergens'] ?? '',
        cells['dg_un_number'] ?? '', cells['dg_class'] ?? '', cells['dg_subsidiary_classes'] ?? '',
        cells['dg_packing_group'] ?? '', cells['high_value'] ?? '', cells['fragile'] ?? '', cells['max_stack_layers'] ?? '',
      ];
    }

    it('Import: the cell grammar, the derivation, class 8 blank / none, and a bad allergen', async () => {
      const p = `IM-${ulid().slice(18)}`;
      const res = await importCsv(HEADER, [
        row(`${p}-DG`, { dg_un_number: 'UN1203', dg_class: '3', dg_packing_group: 'ii', dg_subsidiary_classes: '6.1; ;6.1' }),
        row(`${p}-C8`, { dg_un_number: '1830', dg_class: '8' }),
        row(`${p}-C8N`, { dg_un_number: '1830', dg_class: '8', hazard_class: 'None' }),
        row(`${p}-BAD`, { food_category: 'dairy', allergens: 'milk;peanut' }),
        row(`${p}-FOOD`, { food_category: 'Dairy', allergens: 'MILK; eggs;milk', drug_schedules: 'h;c;H', high_value: 'TRUE', fragile: '1', max_stack_layers: '4' }),
        row(`${p}-MIS`, { dg_un_number: '1230', dg_class: '6.1', hazard_class: 'flammable' }),
        row(`${p}-STK`, { max_stack_layers: '0' }),
        row(`${p}-CA`, { dg_un_number: '1789', dg_class: '8', hazard_class: 'Corrosive-Acid' }),
        row(`${p}-FL`, { dg_un_number: '1203', dg_class: '3', hazard_class: 'FLAMMABLE' }),
        row(`${p}-NF`, { food_category: 'non-food', allergens: 'milk' }),
        row(`${p}-NOCAT`, { allergens: 'milk' }),
        row(`${p}-PG`, { dg_un_number: '1950', dg_class: '2.1', dg_packing_group: 'II' }),
        row(`${p}-ORPH`, { dg_un_number: '1203' }),
        row(`${p}-C8X`, { dg_un_number: '1830', dg_class: '8', hazard_class: 'toxic' }),
      ]).expect(201);
      const errors = res.body.errors as { skuCode: string; code: string; detail: string }[];
      const byCode = new Map(errors.map((error) => [error.skuCode, error]));
      expect(byCode.get(`${p}-C8`)).toMatchObject({
        code: 'dg-hazard-required',
        detail: 'dg_class 8 (corrosives) needs its hazard class — write hazard_class corrosive-acid, corrosive-base or none.',
      });
      expect(byCode.get(`${p}-C8X`)).toMatchObject({
        code: 'dg-hazard-mismatch',
        detail: 'dg_class 8 (corrosives) takes hazard_class corrosive-acid, corrosive-base or none — not "toxic".',
      });
      expect(byCode.get(`${p}-NF`)).toMatchObject({
        code: 'validation-failed',
        detail: 'allergens cannot be declared on a non-food SKU — leave the allergens cell blank.',
      });
      expect(byCode.get(`${p}-NOCAT`)).toMatchObject({
        code: 'validation-failed',
        detail: 'allergens need a food category — fill food_category, or leave the allergens cell blank.',
      });
      expect(byCode.get(`${p}-PG`)).toMatchObject({
        code: 'validation-failed',
        detail: 'dg_class 2.1 takes no packing group — leave dg_packing_group blank.',
      });
      expect(byCode.get(`${p}-ORPH`)).toMatchObject({
        code: 'validation-failed',
        detail:
          'A dangerous good needs both dg_un_number and dg_class — dg_class is missing. Fill dg_class, or leave dg_un_number, dg_packing_group and dg_subsidiary_classes blank.',
      });
      expect(byCode.get(`${p}-BAD`)).toMatchObject({ code: 'validation-failed' });
      expect(byCode.get(`${p}-BAD`)!.detail).toContain('allergens');
      expect(byCode.get(`${p}-BAD`)!.detail).toContain('peanut');
      expect(byCode.get(`${p}-MIS`)).toMatchObject({
        code: 'dg-hazard-mismatch',
        detail: 'dg_class 6.1 sets hazard_class to "toxic" — leave hazard_class blank or write toxic (got "flammable").',
      });
      expect(byCode.get(`${p}-STK`)).toMatchObject({ code: 'validation-failed' });
      expect(byCode.get(`${p}-STK`)!.detail).toContain('max_stack_layers');
      expect(res.body).toMatchObject({ committedRows: 5, failedRows: 9 });
      // The hazard_class cell is case-insensitive like every goods-type cell.
      expect(await skuByCode(`${p}-CA`)).toMatchObject({ dgClass: '8', hazardClass: 'corrosive-acid' });
      expect(await skuByCode(`${p}-FL`)).toMatchObject({ dgClass: '3', hazardClass: 'flammable' });

      expect(await skuByCode(`${p}-DG`)).toMatchObject({
        dgUnNumber: '1203',
        dgClass: '3',
        dgPackingGroup: 'II',
        dgSubsidiaryClasses: ['6.1'],
        hazardClass: 'flammable',
      });
      expect(await skuByCode(`${p}-C8N`)).toMatchObject({ dgClass: '8', hazardClass: null });
      expect(await skuByCode(`${p}-FOOD`)).toMatchObject({
        foodCategory: 'dairy',
        allergens: ['eggs', 'milk'],
        drugSchedules: ['C', 'H'],
        highValue: true,
        fragile: true,
        maxStackLayers: 4,
      });
    });

    it('an import row and a single-SKU create with the same values store the same goods-type fields, the derived hazard included', async () => {
      const p = `PAR-${ulid().slice(18)}`;
      await importCsv(HEADER, [
        row(`${p}-I`, {
          dg_un_number: 'UN3065', dg_class: '3', dg_subsidiary_classes: '6.1', dg_packing_group: 'III',
          food_category: 'beverages', allergens: 'sulphite', drug_schedules: 'C;H', high_value: 'true', fragile: 'true', max_stack_layers: '2',
        }),
      ]).expect(201);
      const created = await newSku({
        code: `${p}-C`,
        dgUnNumber: 'UN3065', dgClass: '3', dgSubsidiaryClasses: ['6.1'], dgPackingGroup: 'III',
        foodCategory: 'beverages', allergens: ['sulphite'], drugSchedules: ['H', 'C'], highValue: true, fragile: true, maxStackLayers: 2,
      });
      const imported = await skuByCode(`${p}-I`);
      expect(await stored(imported.id)).toEqual(await stored(created.id));
      expect((await stored(created.id))['hazard_class']).toBe('flammable');
    });
  });

  // ── the device snapshot ────────────────────────────────────────────────────

  describe('the device snapshot', () => {
    async function badgeInOperator(): Promise<string> {
      const auth = (t: request.Test) => t.set('Authorization', `Bearer ${ownerToken}`);
      const minted = await auth(http().post(`${API}/${tenantId}/devices/enrollment-codes`)).set(KEY_HEADER, ulid()).expect(201);
      const enrolled = await http()
        .post(`${API}/${tenantId}/devices/enroll`)
        .set(KEY_HEADER, ulid())
        .send({ code: minted.body.code, label: 'Goods scanner', pin: '1357' })
        .expect(201);
      const operatorEmail = `operator-${ulid().toLowerCase()}@example.com`;
      const invited = await auth(http().post(`${API}/${tenantId}/users`))
        .set(KEY_HEADER, ulid())
        .send({ email: operatorEmail, role: 'operator' })
        .expect(201);
      await http()
        .post(`${API}/${tenantId}/accept-invite`)
        .set(KEY_HEADER, ulid())
        .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
        .expect(200);
      const badged = await http()
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail, pin: '1357' })
        .expect(200);
      return badged.body.accessToken as string;
    }

    it('GET …/devices/catalog-snapshot (device session) carries the handling arm; a plain SKU\'s dg is null', async () => {
      const dg = await newSku({ highValue: true, maxStackLayers: 3, dgClass: '6.1', dgUnNumber: '1230', dgSubsidiaryClasses: ['3'], dgPackingGroup: 'I' });
      const plain = await newSku();
      const warehouseId = (
        await http()
          .post(`${API}/${tenantId}/warehouses`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ origin: testAddress(), code: `SN-${ulid().slice(10, 16).toUpperCase()}`, name: `Snapshot Depot ${ulid()}` })
          .expect(201)
      ).body.id as string;
      const token = await badgeInOperator();
      const res = await http()
        .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const skus = res.body.skus as Record<string, unknown>[];
      const dgSku = skus.find((s) => s['id'] === dg.id)!;
      expect({ fragile: dgSku['fragile'], highValue: dgSku['highValue'], maxStackLayers: dgSku['maxStackLayers'], dg: dgSku['dg'] }).toEqual({
        fragile: false,
        highValue: true,
        maxStackLayers: 3,
        dg: { unNumber: '1230', class: '6.1', subsidiaryClasses: ['3'], packingGroup: 'I' },
      });
      const plainSku = skus.find((s) => s['id'] === plain.id)!;
      expect({ fragile: plainSku['fragile'], highValue: plainSku['highValue'], maxStackLayers: plainSku['maxStackLayers'], dg: plainSku['dg'] }).toEqual({
        fragile: false,
        highValue: false,
        maxStackLayers: null,
        dg: null,
      });
    });

    it('Handheld: fragile, highValue, maxStackLayers and dg ride the snapshot; a SKU without DG carries dg null', async () => {
      const dg = await newSku({ fragile: true, maxStackLayers: 1, dgClass: '3', dgUnNumber: '1230', dgSubsidiaryClasses: ['6.1'], dgPackingGroup: 'II' });
      const plain = await newSku();
      const summaries = await app.get(CatalogFacade).getSkuSummaries(tenantId);
      const dgSummary = summaries.find((s) => s.id === dg.id)!;
      expect({ fragile: dgSummary.fragile, highValue: dgSummary.highValue, maxStackLayers: dgSummary.maxStackLayers, dg: dgSummary.dg }).toEqual({
        fragile: true,
        highValue: false,
        maxStackLayers: 1,
        dg: { unNumber: '1230', class: '3', subsidiaryClasses: ['6.1'], packingGroup: 'II' },
      });
      const plainSummary = summaries.find((s) => s.id === plain.id)!;
      expect({ fragile: plainSummary.fragile, highValue: plainSummary.highValue, maxStackLayers: plainSummary.maxStackLayers, dg: plainSummary.dg }).toEqual({
        fragile: false,
        highValue: false,
        maxStackLayers: null,
        dg: null,
      });
    });
  });

  // ── story 1-6b: goods-type segregation — the edit guard, the SQL pin, the listing ──

  describe('story 1-6b: goods-type segregation', () => {
    /** A warehouse of its own with the named storage bins (the 12-1/12-2 guard tests' shape). */
    async function depot(prefix: string, binCodes: string[]): Promise<{ warehouseId: string; warehouseCode: string; bins: Map<string, string> }> {
      const warehouseCode = `${prefix}-${ulid().slice(10, 16).toUpperCase()}`;
      const warehouseId = (
        await http()
          .post(`${API}/${tenantId}/warehouses`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ origin: testAddress(), code: warehouseCode, name: `Segregation Depot ${ulid()}` })
          .expect(201)
      ).body.id as string;
      const zoneId = (
        await http()
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code: 'S', name: 'Segregation aisle' })
          .expect(201)
      ).body.id as string;
      const bins = new Map<string, string>();
      for (const code of binCodes) {
        bins.set(
          code,
          (
            await http()
              .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
              .set('Authorization', `Bearer ${ownerToken}`)
              .set(KEY_HEADER, ulid())
              .send({ code, capacity: 1000, type: 'shelf' })
              .expect(201)
          ).body.id as string,
        );
      }
      return { warehouseId, warehouseCode, bins };
    }

    /** Park stock directly — the named `stock.adjust` bypass shape (a mixed bin can pre-exist). */
    async function park(warehouseId: string, binId: string, ...skuIds: string[]): Promise<void> {
      for (const id of skuIds) {
        await sql`insert into stock_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, quantity)
                  values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${id}, ${binId}, ${toMilli(1)})`;
      }
    }

    it('EMPTY_PROFILE_SQL agrees with isEmptyProfile on every stored SKU (the arrays default to {}, never null)', async () => {
      // One of each shape the predicate distinguishes, beside everything the suite created.
      await newSku();
      await newSku({ foodCategory: 'non-food' });
      await newSku({ foodCategory: 'dairy', allergens: ['milk'] });
      await newSku({ drugSchedules: ['H'] });
      await newSku({ dgClass: '9', dgUnNumber: '3480' });
      await newSku({ dgClass: '9', dgUnNumber: '3480', dgSubsidiaryClasses: ['8'] });
      await newSku({ hazardClass: 'toxic' });
      await newSku({ foodCategory: 'non-food', dgClass: '8', dgUnNumber: '1830', hazardClass: null });
      const db = app.get<Database>(DATABASE);
      const rows = await db
        .select({ id: skusTable.id, nonEmpty: dsql<boolean>`${EMPTY_PROFILE_SQL}`, ...SEGREGATION_PROFILE_COLUMNS })
        .from(skusTable)
        .where(eq(skusTable.tenantId, tenantId));
      expect(rows.length).toBeGreaterThan(8);
      const verdicts = new Set<boolean>();
      for (const row of rows) {
        expect({ id: row.id, nonEmpty: row.nonEmpty }).toEqual({ id: row.id, nonEmpty: !isEmptyProfile(profileOf(row)) });
        verdicts.add(row.nonEmpty);
      }
      expect(verdicts).toEqual(new Set([true, false])); // both arms exercised
    });

    it('Edit: food added / schedule added beside DG 8 none → 409, nothing written', async () => {
      const { warehouseId, bins } = await depot('SG1', ['S-01']);
      const sku = await newSku();
      const corrosive = await newSku({ dgClass: '8', dgUnNumber: '1830', hazardClass: null });
      await park(warehouseId, bins.get('S-01')!, sku.id, corrosive.id);
      const food = await patchSku(sku.id, { foodCategory: 'dairy' }).expect(409);
      expectProblem(food, 409, 'hazard-segregation-conflict');
      expect(String(food.body.detail)).toContain('S-01');
      expect(String(food.body.detail)).toContain(corrosive.code);
      expect(String(food.body.detail)).toContain('food never shares a bin with a chemical');
      const drug = await patchSku(sku.id, { drugSchedules: ['H'] }).expect(409);
      expectProblem(drug, 409, 'hazard-segregation-conflict');
      expect(String(drug.body.detail)).toContain('a scheduled drug never shares a bin with a chemical');
      expect(await stored(sku.id)).toMatchObject({ food_category: null, drug_schedules: [] });
    });

    it('Edit: a flammable drug beside rice that drops its schedule becomes a chemical → 409', async () => {
      const { warehouseId, bins } = await depot('SG2', ['S-01']);
      const drug = await newSku({ drugSchedules: ['H'], hazardClass: 'flammable' });
      const rice = await newSku({ foodCategory: 'packaged-dry-grocery' });
      await park(warehouseId, bins.get('S-01')!, drug.id, rice.id);
      const res = await patchSku(drug.id, { drugSchedules: [] }).expect(409);
      expectProblem(res, 409, 'hazard-segregation-conflict');
      expect(String(res.body.detail)).toContain(rice.code);
      expect(await stored(drug.id)).toMatchObject({ drug_schedules: ['H'] });
    });

    it('Edit: allergens removed beside a [milk] food, and a DG 3 beverage turned non-food beside juice → 409', async () => {
      const { warehouseId, bins } = await depot('SG3', ['S-01', 'S-02']);
      const milkA = await newSku({ foodCategory: 'confectionery', allergens: ['milk'] });
      const milkB = await newSku({ foodCategory: 'confectionery', allergens: ['milk'] });
      await park(warehouseId, bins.get('S-01')!, milkA.id, milkB.id);
      const allergen = await patchSku(milkA.id, { allergens: [] }).expect(409);
      expectProblem(allergen, 409, 'hazard-segregation-conflict');
      expect(String(allergen.body.detail)).toContain('two foods share a bin only when they declare the same allergens');
      expect(await stored(milkA.id)).toMatchObject({ allergens: ['milk'] });

      const whisky = await newSku({ foodCategory: 'beverages', dgClass: '3', dgUnNumber: '3065' });
      const juice = await newSku({ foodCategory: 'beverages' });
      await park(warehouseId, bins.get('S-02')!, whisky.id, juice.id);
      const nonFood = await patchSku(whisky.id, { foodCategory: 'non-food' }).expect(409);
      expectProblem(nonFood, 409, 'hazard-segregation-conflict');
      expect(String(nonFood.body.detail)).toContain(juice.code);
      expect(await stored(whisky.id)).toMatchObject({ food_category: 'beverages' });
    });

    it('Edit: an already-mixed bin passes an unrelated edit and an edit that keeps the same conflict keys', async () => {
      const { warehouseId, bins } = await depot('SG4', ['S-01']);
      const rice = await newSku({ foodCategory: 'packaged-dry-grocery' });
      const battery = await newSku({ dgClass: '9', dgUnNumber: '3480' });
      await park(warehouseId, bins.get('S-01')!, rice.id, battery.id);
      expect((await patchSku(rice.id, { name: 'Basmati rice' }).expect(200)).body.name).toBe('Basmati rice');
      // {food-chemical} before and after — no worse.
      expect((await patchSku(rice.id, { allergens: ['milk'] }).expect(200)).body.allergens).toEqual(['milk']);
    });

    it('Edit: 12-2 regress — explosive → flammable beside an oxidizer is still refused', async () => {
      const { warehouseId, bins } = await depot('SG5', ['S-01']);
      const sku = await newSku({ hazardClass: 'explosive' });
      const oxidizer = await newSku({ hazardClass: 'oxidizer' });
      await park(warehouseId, bins.get('S-01')!, sku.id, oxidizer.id);
      expectProblem(await patchSku(sku.id, { hazardClass: 'flammable' }).expect(409), 409, 'hazard-segregation-conflict');
      expect(await stored(sku.id)).toMatchObject({ hazard_class: 'explosive' });
    });

    it('Edit: the 409 lists every newly conflicting bin and binmate', async () => {
      const { warehouseId, bins } = await depot('SG6', ['S-01', 'S-02', 'S-03']);
      const sku = await newSku();
      const battery = await newSku({ dgClass: '9', dgUnNumber: '3480' });
      const toxic = await newSku({ hazardClass: 'toxic' });
      const tshirt = await newSku({ foodCategory: 'non-food' });
      await park(warehouseId, bins.get('S-01')!, sku.id, battery.id);
      await park(warehouseId, bins.get('S-02')!, sku.id, toxic.id);
      await park(warehouseId, bins.get('S-03')!, sku.id, tshirt.id);
      const res = await patchSku(sku.id, { foodCategory: 'other-food' }).expect(409);
      const detail = String(res.body.detail);
      expect(detail).toContain('"S-01"');
      expect(detail).toContain(battery.code);
      expect(detail).toContain('"S-02"');
      expect(detail).toContain(toxic.code);
      expect(detail).not.toContain('"S-03"');
      expect(detail).not.toContain(tshirt.code);
    });

    it('Edit: a DG-only PATCH whose derived hazard (5.1 → oxidizer) conflicts with a flammable binmate → 409', async () => {
      const { warehouseId, bins } = await depot('SG7', ['S-01']);
      const sku = await newSku();
      const flammable = await newSku({ hazardClass: 'flammable' });
      await park(warehouseId, bins.get('S-01')!, sku.id, flammable.id);
      const res = await patchSku(sku.id, { dgClass: '5.1', dgUnNumber: '1479' }).expect(409);
      expectProblem(res, 409, 'hazard-segregation-conflict');
      expect(String(res.body.detail)).toContain('oxidizer');
      expect(String(res.body.detail)).toContain(flammable.code);
      expect(await stored(sku.id)).toMatchObject({ dg_class: null, hazard_class: null });
    });

    it('Edit: a goods-type conflict against an open QC hold\'s origin bin → 409 naming the origin bin and the hold', async () => {
      const { warehouseId, bins } = await depot('SG8', ['S-01']);
      const sku = await newSku();
      const battery = await newSku({ dgClass: '9', dgUnNumber: '3480' });
      await park(warehouseId, bins.get('S-01')!, sku.id, battery.id);
      // The hold moves the SKU's units out to the QC-HOLD bin; S-01 is now only its ORIGIN.
      const hold = (
        await http()
          .post(`${API}/${tenantId}/receiving/qc-holds`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ warehouseId, skuId: sku.id, binId: bins.get('S-01')!, reason: 'damaged carton' })
          .expect(201)
      ).body.qcHold as { id: string };
      const res = await patchSku(sku.id, { foodCategory: 'dairy' }).expect(409);
      expectProblem(res, 409, 'hazard-segregation-conflict');
      const detail = String(res.body.detail);
      expect(detail).toContain('origin bin "S-01"');
      expect(detail).toContain(hold.id);
      expect(detail).toContain(battery.code);
      expect(detail).toContain('food never shares a bin with a chemical');
    });

    it('Edit: an edit to an EMPTY profile beside conflicting stock → 200 (an empty profile carries no rule)', async () => {
      const { warehouseId, bins } = await depot('SG9', ['S-01']);
      const rice = await newSku({ foodCategory: 'packaged-dry-grocery' });
      const battery = await newSku({ dgClass: '9', dgUnNumber: '3480' });
      await park(warehouseId, bins.get('S-01')!, rice.id, battery.id);
      expect((await patchSku(rice.id, { foodCategory: 'non-food' }).expect(200)).body.foodCategory).toBe('non-food');
    });

    it('scripts/segregation-conflicts.ts exits 2 (never a false all-clear) for a --tenant that does not exist', async () => {
      const run = spawnSync('bun', ['scripts/segregation-conflicts.ts', '--tenant', uuidv7(), '--json'], {
        cwd: resolve(__dirname, '..'),
        env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, DATABASE_AUTH_URL: process.env.DATABASE_URL },
        encoding: 'utf8',
      });
      expect(run.status).toBe(2);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('does not exist');
    });

    it('scripts/segregation-conflicts.ts lists exactly the two seeded mixed bins and the rule for each; a clean bin is not listed', async () => {
      const { warehouseId, warehouseCode, bins } = await depot('SGL', ['M-01', 'M-02', 'C-01']);
      const rice = await newSku({ foodCategory: 'packaged-dry-grocery' });
      const battery = await newSku({ dgClass: '9', dgUnNumber: '3480' });
      const milkSweet = await newSku({ foodCategory: 'confectionery', allergens: ['milk'] });
      const plainSweet = await newSku({ foodCategory: 'confectionery' });
      const tshirt = await newSku({ foodCategory: 'non-food' });
      await park(warehouseId, bins.get('M-01')!, rice.id, battery.id);
      await park(warehouseId, bins.get('M-02')!, milkSweet.id, plainSweet.id);
      await park(warehouseId, bins.get('C-01')!, rice.id, tshirt.id);
      const run = spawnSync('bun', ['scripts/segregation-conflicts.ts', '--tenant', tenantId, '--json'], {
        cwd: resolve(__dirname, '..'),
        env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, DATABASE_AUTH_URL: process.env.DATABASE_URL },
        encoding: 'utf8',
      });
      expect(run.stderr).toBe('');
      expect(run.status).toBe(1); // mixed bins exist
      const listed = run.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { warehouseCode: string; binCode: string; rule: string; skuA: string; skuB: string; detail: string })
        .filter((row) => row.warehouseCode === warehouseCode)
        .map(({ binCode, rule }) => ({ binCode, rule }));
      expect(listed).toEqual([
        { binCode: 'M-01', rule: 'food-chemical' },
        { binCode: 'M-02', rule: 'allergen-mismatch' },
      ]);
    });
  });
});
