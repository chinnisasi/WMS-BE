import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { DATABASE } from '../src/shared/shared.module';
import { TenancyService } from '../src/modules/tenancy/tenancy.service';

// The e2e suite talks to the real Postgres (docker-compose dev DB by default;
// CI provides the service container) and signs sessions.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';

const IDENTITY_URL = '/api/v1/tenants';

/** Stable per-email payload so the same key replays the same hash. */
function registrationBody(email: string): Record<string, unknown> {
  return { name: `Priya Spices ${email.split('@')[0]}`, ownerEmail: email, password: 'correct-horse-battery' };
}

function warehouseBody(code: string): Record<string, unknown> {
  return { code, name: `Whitefield ${ulid()}` };
}

describe('tenancy (e2e)', () => {
  let app: INestApplication;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    app = await createApp(false);
    await app.init();
  });

  afterAll(async () => {
    await cleanupRows();
    // Close the shared pool (drizzle exposes it as $client) so jest exits.
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    await app.close();
  });

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await sql.unsafe('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM warehouses WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM tenants WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
    } finally {
      await sql.end();
    }
  }

  function registerTenant(email: string, idempotencyKey = ulid()): SupertestTest {
    return request(app.getHttpServer())
      .post(IDENTITY_URL)
      .set('Idempotency-Key', idempotencyKey)
      .send(registrationBody(email));
  }

  async function signIn(email: string, password = 'correct-horse-battery'): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/sign-in`)
      .send({ email, password })
      .expect(200);
    return res.body.accessToken as string;
  }

  test('registration creates a tenant + owner user, exposing no password material', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const res = await registerTenant(email).expect(201);
    createdTenantIds.push(res.body.tenant.id);

    expect(res.body.tenant.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.tenant.name).toMatch(/^Priya Spices /);
    expect(res.body.owner.email).toBe(email);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain('correct-horse-battery');
  });

  test('registration stamps tenant_id on every created row', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const res = await registerTenant(email).expect(201);
    createdTenantIds.push(res.body.tenant.id);

    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const tenantRow = await sql`select tenant_id, name from tenants where id = ${res.body.tenant.id}`;
      const userRow = await sql`select tenant_id, email, password_hash from users where id = ${res.body.owner.id}`;
      expect(tenantRow[0]!.tenant_id).toBe(res.body.tenant.id);
      expect(userRow[0]!.tenant_id).toBe(res.body.tenant.id);
      expect(userRow[0]!.email).toBe(email);
      expect(String(userRow[0]!.password_hash)).toMatch(/^scrypt:/);
      expect(String(userRow[0]!.password_hash)).not.toContain('correct-horse-battery');
    } finally {
      await sql.end();
    }
  });

  test('replay with the same Idempotency-Key re-serves the original 201 response', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const key = ulid();
    const first = await registerTenant(email, key).expect(201);
    createdTenantIds.push(first.body.tenant.id);
    const replay = await registerTenant(email, key).expect(201);

    expect(replay.body).toEqual(first.body);

    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const users = await sql`select count(*)::int as n from users where email = ${email}`;
      const tenantsCount = await sql`select count(*)::int as n from tenants where id = ${first.body.tenant.id}`;
      const keys = await sql`select count(*)::int as n from idempotency_keys where key = ${key}`;
      expect(users[0]!.n).toBe(1);
      expect(tenantsCount[0]!.n).toBe(1);
      expect(keys[0]!.n).toBe(1);
    } finally {
      await sql.end();
    }
  });

  test('reusing an Idempotency-Key with a different payload is 422 idempotency-key-reuse', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const key = ulid();
    const first = await registerTenant(email, key).expect(201);
    createdTenantIds.push(first.body.tenant.id);

    const res = await request(app.getHttpServer())
      .post(IDENTITY_URL)
      .set('Idempotency-Key', key)
      .send({ name: 'A different business', ownerEmail: email, password: 'correct-horse-battery' })
      .expect(422);
    expect(res.body).toMatchObject({ code: 'idempotency-key-reuse' });
  });

  test('duplicate owner email is 409 duplicate-email, creating nothing', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const first = await registerTenant(email).expect(201);
    createdTenantIds.push(first.body.tenant.id);

    const duplicateKey = ulid();
    const res = await request(app.getHttpServer())
      .post(IDENTITY_URL)
      .set('Idempotency-Key', duplicateKey)
      .send(registrationBody(email))
      .expect(409);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 409, code: 'duplicate-email' });
    expect(res.body.detail).toContain(email);

    // Rollback: the failed attempt left no partial rows behind — no user
    // beyond the original owner, no idempotency record for the failed key.
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const users = await sql`select count(*)::int as n from users where email = ${email}`;
      const keys = await sql`select count(*)::int as n from idempotency_keys where key = ${duplicateKey}`;
      expect(users[0]!.n).toBe(1);
      expect(keys[0]!.n).toBe(0);
    } finally {
      await sql.end();
    }
  });

  test('missing or malformed Idempotency-Key is rejected with 400', async () => {
    const missing = await request(app.getHttpServer())
      .post(IDENTITY_URL)
      .send(registrationBody(`owner-${ulid().toLowerCase()}@example.com`))
      .expect(400);
    expect(missing.body).toMatchObject({ code: 'idempotency-key-required' });

    const malformed = await request(app.getHttpServer())
      .post(IDENTITY_URL)
      .set('Idempotency-Key', 'not-a-ulid')
      .send(registrationBody(`owner-${ulid().toLowerCase()}@example.com`))
      .expect(400);
    expect(malformed.body).toMatchObject({ code: 'idempotency-key-invalid' });
  });

  test('sign-in verifies the password and returns a short-lived HS256 session', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await registerTenant(email).expect(201);
    createdTenantIds.push(registered.body.tenant.id);

    const token = await signIn(email);
    const [, payloadPart] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadPart!, 'base64url').toString('utf8')) as {
      sub: string;
      tenant_id: string;
      exp: number;
    };
    expect(payload.sub).toBe(registered.body.owner.id);
    expect(payload.tenant_id).toBe(registered.body.tenant.id);
    expect(payload.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(15 * 60);

    const wrong = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/sign-in`)
      .send({ email, password: 'definitely-not-it' })
      .expect(401);
    expect(wrong.body).toMatchObject({ code: 'unauthenticated' });
  });

  test('warehouse creation with a session appears in the tenant list; duplicates name the code', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await registerTenant(email).expect(201);
    createdTenantIds.push(registered.body.tenant.id);
    const token = await signIn(email);
    const tenantId = registered.body.tenant.id as string;
    const code = `BLR-${ulid().slice(0, 6).toUpperCase()}`;

    const created = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', ulid())
      .send(warehouseBody(code))
      .expect(201);
    expect(created.body).toMatchObject({ tenantId, code });
    expect(created.body.id).toMatch(/^[0-9a-f-]{36}$/);

    const list = await request(app.getHttpServer())
      .get(`${IDENTITY_URL}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.items.map((w: { code: string }) => w.code)).toContain(code);
    expect(list.body.nextCursor).toBeNull();

    const duplicate = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', ulid())
      .send(warehouseBody(code))
      .expect(409);
    expect(duplicate.body).toMatchObject({ status: 409, code: 'duplicate-warehouse-code' });
    expect(duplicate.body.detail).toContain(code);

    const replay = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', ulid())
      .send(warehouseBody(code))
      .expect(409);
    // A different key on the same payload is not a replay — the code conflict wins.
    expect(replay.body.code).toBe('duplicate-warehouse-code');
  });

  test('warehouse replay: same key re-serves the original 201; same key + different payload 422s', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await registerTenant(email).expect(201);
    createdTenantIds.push(registered.body.tenant.id);
    const token = await signIn(email);
    const tenantId = registered.body.tenant.id as string;
    const code = `BLR-${ulid().slice(0, 6).toUpperCase()}`;
    const key = ulid();

    const send = (body: Record<string, unknown>, idempotencyKey = key): SupertestTest =>
      request(app.getHttpServer())
        .post(`${IDENTITY_URL}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(body);

    // warehouseBody() randomizes the name per call — build the payload once
    // so the resend below is byte-for-byte identical (a differing payload is
    // the 422 case, not a replay).
    const body = warehouseBody(code);
    const first = await send(body).expect(201);

    // Verbatim resend (the form's double-submit / retry path): the stored
    // snapshot is re-served, no second warehouse row appears.
    const replay = await send(body).expect(201);
    expect(replay.body).toEqual(first.body);
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`select count(*)::int as n from warehouses where tenant_id = ${tenantId} and code = ${code}`;
      expect(rows[0]!.n).toBe(1);
    } finally {
      await sql.end();
    }

    // Same key, different payload → idempotency-key-reuse, not a replay.
    const reuse = await send({ code, name: 'A different name entirely' }).expect(422);
    expect(reuse.body).toMatchObject({ code: 'idempotency-key-reuse' });
  });

  test('warehouse list follows the keyset cursor chain; malformed cursor is 400', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await registerTenant(email).expect(201);
    createdTenantIds.push(registered.body.tenant.id);
    const token = await signIn(email);
    const tenantId = registered.body.tenant.id as string;
    // ulid()'s first 10 chars are the timestamp — slice from the randomness
    // region so three codes minted in the same millisecond stay distinct.
    const codes = [
      `BLR-${ulid().slice(10, 16).toUpperCase()}`,
      `BLR-${ulid().slice(10, 16).toUpperCase()}`,
      `BLR-${ulid().slice(10, 16).toUpperCase()}`,
    ];
    for (const code of codes) {
      await request(app.getHttpServer())
        .post(`${IDENTITY_URL}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', ulid())
        .send(warehouseBody(code))
        .expect(201);
    }

    // limit=1 walks the cursor chain through all three warehouses.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const res = await request(app.getHttpServer())
        .get(`${IDENTITY_URL}/${tenantId}/warehouses`)
        .query(cursor === undefined ? { limit: 1 } : { limit: 1, cursor })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      seen.push(...res.body.items.map((w: { code: string }) => w.code));
      if (res.body.nextCursor === null) break;
      cursor = res.body.nextCursor as string;
    }
    expect(seen).toHaveLength(3);
    expect(seen.sort()).toEqual([...codes].sort());

    const malformed = await request(app.getHttpServer())
      .get(`${IDENTITY_URL}/${tenantId}/warehouses`)
      .query({ cursor: 'not-a-cursor' })
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    expect(malformed.body).toMatchObject({ code: 'invalid-cursor' });
  });

  test('warehouse endpoints require a session; foreign sessions get permission-denied', async () => {
    const emailA = `owner-${ulid().toLowerCase()}@example.com`;
    const registeredA = await registerTenant(emailA).expect(201);
    createdTenantIds.push(registeredA.body.tenant.id);
    const tenantA = registeredA.body.tenant.id as string;

    await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantA}/warehouses`)
      .set('Idempotency-Key', ulid())
      .send(warehouseBody(`BLR-${ulid().slice(0, 6).toUpperCase()}`))
      .expect(401);

    const emailB = `owner-${ulid().toLowerCase()}@example.com`;
    const registeredB = await registerTenant(emailB).expect(201);
    createdTenantIds.push(registeredB.body.tenant.id);
    const tokenB = await signIn(emailB);

    const cross = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantA}/warehouses`)
      .set('Authorization', `Bearer ${tokenB}`)
      .set('Idempotency-Key', ulid())
      .send(warehouseBody(`BLR-${ulid().slice(0, 6).toUpperCase()}`))
      .expect(403);
    expect(cross.body).toMatchObject({ code: 'permission-denied' });

    const crossList = await request(app.getHttpServer())
      .get(`${IDENTITY_URL}/${tenantA}/warehouses`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(403);
    expect(crossList.body).toMatchObject({ code: 'permission-denied' });
  });

  test('requireActiveWarehouse enforces the zero-warehouse invariant', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await registerTenant(email).expect(201);
    createdTenantIds.push(registered.body.tenant.id);
    const tenantId = registered.body.tenant.id as string;

    const tenancy = app.get(TenancyService);
    let caught: unknown;
    try {
      await tenancy.requireActiveWarehouse(tenantId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getResponse()).toMatchObject({
      code: 'no-active-warehouse',
      status: 422,
    });

    const token = await signIn(email);
    await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', ulid())
      .send(warehouseBody(`BLR-${ulid().slice(0, 6).toUpperCase()}`))
      .expect(201);

    const active = await tenancy.requireActiveWarehouse(tenantId);
    expect(active.warehouseId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('RLS: a tenant-scoped session cannot read another tenant’s warehouse rows', async () => {
    const emailA = `owner-${ulid().toLowerCase()}@example.com`;
    const registeredA = await registerTenant(emailA).expect(201);
    createdTenantIds.push(registeredA.body.tenant.id);
    const tenantA = registeredA.body.tenant.id as string;
    const tokenA = await signIn(emailA);
    const codeA = `BLR-${ulid().slice(0, 6).toUpperCase()}`;
    await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantA}/warehouses`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Idempotency-Key', ulid())
      .send(warehouseBody(codeA))
      .expect(201);

    const emailB = `owner-${ulid().toLowerCase()}@example.com`;
    const registeredB = await registerTenant(emailB).expect(201);
    createdTenantIds.push(registeredB.body.tenant.id);
    const tenantB = registeredB.body.tenant.id as string;

    // The dev/CI role (docker-compose POSTGRES_USER) is a superuser, which
    // bypasses RLS no matter what — so the backstop is verified as a real
    // non-superuser role with table grants, exactly how a deployed app role
    // must be provisioned for RLS to bind at all.
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    let scoped: postgres.Sql<Record<string, unknown>> | undefined;
    try {
      await admin.unsafe(`
        do $$ begin
          if not exists (select from pg_roles where rolname = 'wms_rls_probe') then
            create role wms_rls_probe login password 'wms_rls_probe' nosuperuser;
          end if;
        end $$;
      `);
      await admin.unsafe('grant usage on schema public to wms_rls_probe');
      await admin.unsafe(
        'grant select, insert, update, delete on all tables in schema public to wms_rls_probe',
      );
      const probeUrl = new URL(process.env.DATABASE_URL!);
      probeUrl.username = 'wms_rls_probe';
      probeUrl.password = 'wms_rls_probe';
      scoped = postgres(probeUrl.toString(), { max: 1 });

      const own = await scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
        return tx`select id, code from warehouses where tenant_id = ${tenantA}`;
      });
      expect(own.length).toBe(1);
      expect(own[0]!.code).toBe(codeA);

      const foreign = await scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantB}, true)`;
        return tx`select id, code from warehouses where tenant_id = ${tenantA}`;
      });
      expect(foreign).toHaveLength(0);

      // No app.tenant_id at all → fail closed.
      const unscoped = await scoped`select id from warehouses where tenant_id = ${tenantA}`;
      expect(unscoped).toHaveLength(0);

      // The WRITE side is fail-closed too: the policy's WITH CHECK rejects an
      // INSERT stamped with a foreign tenant_id (42501), so a scoped connection
      // cannot seed rows into a tenant it is not scoped to.
      const foreignInsert = scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
        await tx`insert into warehouses (id, tenant_id, code, name)
          values (${uuidv7()}, ${tenantB}, ${`RLS-${ulid().slice(0, 6)}`}, 'rls probe')`;
      });
      expect(foreignInsert).rejects.toThrow(/row-level security/i);
    } finally {
      await scoped?.end();
      await admin.end();
    }
  });

  test('the OpenAPI document exposes the tenancy contract (drift guard companion)', async () => {
    const committed = JSON.parse(
      readFileSync(resolve(process.cwd(), 'openapi/openapi.json'), 'utf8') as string,
    ) as { paths: Record<string, unknown> };
    expect(Object.keys(committed.paths)).toEqual(
      expect.arrayContaining([
        '/tenants',
        '/tenants/sign-in',
        '/tenants/{tenantId}/warehouses',
      ]),
    );
  });

  test('uuidv7 primitive keeps producing valid v7 ids (test-support sanity)', () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});