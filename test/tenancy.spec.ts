import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { signTenantSession } from '../src/modules/tenancy/jwt-session';
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
    // Deployment parity for the auth connection (review loop 2): point
    // DATABASE_AUTH_URL at a real non-superuser BYPASSRLS role so sign-in and
    // the registration replay run under RLS-binding conditions, not the
    // superuser fallback. The lazy proxy reads the env on first auth query —
    // set it before the suite touches the endpoints.
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await admin.unsafe(`
        do $$ begin
          if not exists (select from pg_roles where rolname = 'wms_auth_probe') then
            create role wms_auth_probe login password 'wms_auth_probe' nosuperuser bypassrls;
          end if;
        end $$;
      `);
      await admin.unsafe('grant usage on schema public to wms_auth_probe');
      await admin.unsafe(
        'grant select, insert, update, delete on all tables in schema public to wms_auth_probe',
      );
      const authUrl = new URL(process.env.DATABASE_URL!);
      authUrl.username = 'wms_auth_probe';
      authUrl.password = 'wms_auth_probe';
      process.env.DATABASE_AUTH_URL = authUrl.toString();
    } finally {
      await admin.end();
    }
    app = await createApp(false);
    await app.init();
  });

  afterAll(async () => {
    await cleanupRows();
    // Close both shared pools (drizzle exposes them as $client) so jest exits.
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
  });

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await sql.unsafe('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      // Children before parents: bins → zones → warehouses (no FKs, but the
      // order keeps the intent legible).
      await sql.unsafe('DELETE FROM bins WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM zones WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
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

  /** Register → sign in → create one warehouse: the zone/bin test scaffold. */
  async function setupTenantWithWarehouse(): Promise<{
    tenantId: string;
    token: string;
    warehouseId: string;
  }> {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await registerTenant(email).expect(201);
    createdTenantIds.push(registered.body.tenant.id);
    const tenantId = registered.body.tenant.id as string;
    const token = await signIn(email);
    const warehouseId = await createWarehouseFor(tenantId, token);
    return { tenantId, token, warehouseId };
  }

  /** One warehouse in an existing tenant (the 1.2 surface). */
  async function createWarehouseFor(tenantId: string, token: string): Promise<string> {
    const warehouse = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', ulid())
      .send(warehouseBody(`BLR-${ulid().slice(10, 16).toUpperCase()}`))
      .expect(201);
    return warehouse.body.id as string;
  }

  function createZone(
    token: string,
    tenantId: string,
    warehouseId: string,
    body: Record<string, unknown>,
    idempotencyKey = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/warehouses/${warehouseId}/zones`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
  }

  function createBin(
    token: string,
    tenantId: string,
    warehouseId: string,
    zoneId: string,
    body: Record<string, unknown>,
    idempotencyKey = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
  }

  function generateBins(
    token: string,
    tenantId: string,
    warehouseId: string,
    zoneId: string,
    body: Record<string, unknown>,
    idempotencyKey = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins/grid`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
  }

  function listBins(
    token: string,
    tenantId: string,
    warehouseId: string,
    zoneId: string,
    query: Record<string, unknown> = {},
  ): SupertestTest {
    return request(app.getHttpServer())
      .get(`${IDENTITY_URL}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
      .query(query)
      .set('Authorization', `Bearer ${token}`);
  }

  function patchBin(
    token: string,
    tenantId: string,
    warehouseId: string,
    binId: string,
    body: Record<string, unknown>,
    idempotencyKey = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .patch(`${IDENTITY_URL}/${tenantId}/warehouses/${warehouseId}/bins/${binId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
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

  test('warehouse create rejects a malformed Idempotency-Key with 400 (same contract as registration)', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await registerTenant(email).expect(201);
    createdTenantIds.push(registered.body.tenant.id);
    const token = await signIn(email);
    const tenantId = registered.body.tenant.id as string;

    const res = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'not-a-ulid')
      .send(warehouseBody(`BLR-${ulid().slice(10, 16).toUpperCase()}`))
      .expect(400);
    expect(res.body).toMatchObject({ code: 'idempotency-key-invalid' });
  });

  test('warehouse list limit is bounded (0 and 201 are 400, 1 and 200 pass validation)', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await registerTenant(email).expect(201);
    createdTenantIds.push(registered.body.tenant.id);
    const token = await signIn(email);
    const tenantId = registered.body.tenant.id as string;
    const get = (limit: number): SupertestTest =>
      request(app.getHttpServer())
        .get(`${IDENTITY_URL}/${tenantId}/warehouses`)
        .query({ limit })
        .set('Authorization', `Bearer ${token}`);

    expect((await get(0).expect(400)).body).toMatchObject({ code: 'validation-failed' });
    expect((await get(201).expect(400)).body).toMatchObject({ code: 'validation-failed' });
    await get(1).expect(200);
    await get(200).expect(200);
  });

  test('a present-but-invalid bearer token is 401 unauthenticated', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await registerTenant(email).expect(201);
    createdTenantIds.push(registered.body.tenant.id);
    const tenantId = registered.body.tenant.id as string;
    const userId = registered.body.owner.id as string;
    const secret = process.env.JWT_SECRET!;

    const sendWith = (token: string) =>
      request(app.getHttpServer())
        .get(`${IDENTITY_URL}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${token}`);

    // Expired: signed a clock-hour ago with the real secret.
    const expired = signTenantSession(tenantId, userId, secret, Math.floor(Date.now() / 1000) - 3600);
    const expiredRes = await sendWith(expired).expect(401);
    expect(expiredRes.body).toMatchObject({ code: 'unauthenticated' });

    // Wrong secret: signature fails; the claims look perfect.
    const forged = signTenantSession(tenantId, userId, 'attacker-chosen-secret-0123456789');
    const forgedRes = await sendWith(forged).expect(401);
    expect(forgedRes.body).toMatchObject({ code: 'unauthenticated' });

    // Tampered payload: real signature, different claims — the HMAC must not match.
    const [, realPayload, realSig] = (await signIn(email)).split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({ sub: userId, tenant_id: uuidv7(), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 }),
      'utf8',
    ).toString('base64url');
    const tamperedRes = await sendWith(`${realPayload}.${tamperedPayload}.${realSig}`).expect(401);
    expect(tamperedRes.body).toMatchObject({ code: 'unauthenticated' });
  });

  test('a crafted cursor with a non-uuid id is 400 invalid-cursor, not a 500', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await registerTenant(email).expect(201);
    createdTenantIds.push(registered.body.tenant.id);
    const token = await signIn(email);
    const tenantId = registered.body.tenant.id as string;
    const code = `BLR-${ulid().slice(10, 16).toUpperCase()}`;
    await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', ulid())
      .send(warehouseBody(code))
      .expect(201);

    // base64-valid JSON that decodeCursor's typeof checks accept — only the
    // id-format gate keeps it off the ::uuid cast in SQL.
    const crafted = Buffer.from(
      JSON.stringify({ createdAt: '2026-01-01T00:00:00.000Z', id: 'garbage' }),
      'utf8',
    ).toString('base64url');
    const res = await request(app.getHttpServer())
      .get(`${IDENTITY_URL}/${tenantId}/warehouses`)
      .query({ cursor: crafted })
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    expect(res.body).toMatchObject({ code: 'invalid-cursor' });
  });

  test('padded inputs are trimmed at the validation boundary', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await registerTenant(email).expect(201);
    createdTenantIds.push(registered.body.tenant.id);
    const tenantId = registered.body.tenant.id as string;
    const code = `BLR-${ulid().slice(10, 16).toUpperCase()}`;

    // Sign-in with a whitespace-padded email reaches the normalized lookup.
    await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/sign-in`)
      .send({ email: `  ${email}  `, password: 'correct-horse-battery' })
      .expect(200);

    const token = await signIn(email);
    await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', ulid())
      .send({ code: `  ${code}  `, name: '  Whitefield  ' })
      .expect(201);

    // The trimmed code is the stored one: the unpadded duplicate conflicts.
    const dup = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', ulid())
      .send({ code, name: 'Whitefield again' })
      .expect(409);
    expect(dup.body).toMatchObject({ code: 'duplicate-warehouse-code' });

    // A whitespace-only name trims to '' and fails @Length.
    await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', ulid())
      .send({ code: `BLR-${ulid().slice(10, 16).toUpperCase()}`, name: '   ' })
      .expect(400);
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
      await expect(foreignInsert).rejects.toThrow(/row-level security/i);
    } finally {
      await scoped?.end();
      await admin.end();
    }
  });

  test('zone create is idempotent, listed, and duplicates name the code; foreign warehouse is 404', async () => {
    const { tenantId, token, warehouseId } = await setupTenantWithWarehouse();
    const code = `Z${ulid().slice(10, 13).toUpperCase()}`;
    const body = { code, name: 'Fast movers' };
    const key = ulid();

    const first = await createZone(token, tenantId, warehouseId, body, key).expect(201);
    expect(first.body).toMatchObject({ tenantId, warehouseId, code });
    expect(first.body.id).toMatch(/^[0-9a-f-]{36}$/);

    // Replay: same key + same body re-serves the original 201, no second row.
    const replay = await createZone(token, tenantId, warehouseId, body, key).expect(201);
    expect(replay.body).toEqual(first.body);

    const list = await request(app.getHttpServer())
      .get(`${IDENTITY_URL}/${tenantId}/warehouses/${warehouseId}/zones`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.items.map((z: { code: string }) => z.code)).toContain(code);

    // Duplicate zone code in the same warehouse — names the code.
    const duplicate = await createZone(token, tenantId, warehouseId, body).expect(409);
    expect(duplicate.body).toMatchObject({ status: 409, code: 'duplicate-zone-code' });
    expect(duplicate.body.detail).toContain(code);

    // A nonexistent (or foreign) warehouse is 404 not-found.
    const foreign = await createZone(token, tenantId, uuidv7(), body).expect(404);
    expect(foreign.body).toMatchObject({ code: 'not-found' });
  });

  test('a manual bin is immediately listed and usable; duplicate bin codes name the code across the warehouse', async () => {
    const { tenantId, token, warehouseId } = await setupTenantWithWarehouse();
    const zone = await createZone(token, tenantId, warehouseId, { code: 'A', name: 'Zone A' }).expect(201);
    const zoneId = zone.body.id as string;

    const created = await createBin(token, tenantId, warehouseId, zoneId, {
      code: 'A-01-01',
      capacity: 120,
      type: 'shelf',
    }).expect(201);
    expect(created.body).toMatchObject({
      tenantId,
      warehouseId,
      zoneId,
      code: 'A-01-01',
      capacity: 120,
      type: 'shelf',
      blocked: false,
    });

    // No dormant state: the created bin is right there in the zone's list.
    const listed = await listBins(token, tenantId, warehouseId, zoneId).expect(200);
    expect(listed.body.items.map((b: { code: string }) => b.code)).toContain('A-01-01');
    expect(listed.body.nextCursor).toBeNull();

    // Same code, same zone → 409 naming the code.
    const duplicate = await createBin(token, tenantId, warehouseId, zoneId, {
      code: 'A-01-01',
      capacity: 50,
      type: 'pallet',
    }).expect(409);
    expect(duplicate.body).toMatchObject({ status: 409, code: 'duplicate-bin-code' });
    expect(duplicate.body.detail).toContain('A-01-01');

    // Codes are unique per warehouse, not per zone: a second zone still conflicts.
    const zoneB = await createZone(token, tenantId, warehouseId, { code: 'B', name: 'Zone B' }).expect(201);
    const crossZone = await createBin(token, tenantId, warehouseId, zoneB.body.id as string, {
      code: 'A-01-01',
      capacity: 50,
      type: 'pallet',
    }).expect(409);
    expect(crossZone.body).toMatchObject({ code: 'duplicate-bin-code' });

    // Foreign zone → 404 not-found.
    await createBin(token, tenantId, warehouseId, uuidv7(), {
      code: 'C-01-01',
      capacity: 50,
      type: 'floor',
    }).expect(404);
  });

  test('grid generation creates all bins in one run; replay re-serves the snapshot without double bins', async () => {
    const { tenantId, token, warehouseId } = await setupTenantWithWarehouse();
    const zone = await createZone(token, tenantId, warehouseId, { code: 'A', name: 'Zone A' }).expect(201);
    const zoneId = zone.body.id as string;
    const grid = { aisleFrom: 'A', aisleTo: 'B', baysPerAisle: 2, levelsPerBay: 2, capacity: 100, type: 'pallet' };
    const key = ulid();

    const run = await generateBins(token, tenantId, warehouseId, zoneId, grid, key).expect(201);
    expect(run.body).toMatchObject({
      warehouseId,
      zoneId,
      generatedCount: 8,
      firstCode: 'A-01-01',
      lastCode: 'B-02-02',
    });

    // Replay: same key + same body → the stored snapshot, no second batch.
    const replay = await generateBins(token, tenantId, warehouseId, zoneId, grid, key).expect(201);
    expect(replay.body).toEqual(run.body);
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`select count(*)::int as n from bins where warehouse_id = ${warehouseId}`;
      expect(rows[0]!.n).toBe(8);
    } finally {
      await sql.end();
    }

    // The created bins are immediately listed; the keyset walk sees all 8.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const res = await listBins(token, tenantId, warehouseId, zoneId, { limit: 3, cursor }).expect(200);
      seen.push(...res.body.items.map((b: { code: string }) => b.code));
      if (res.body.nextCursor === null) break;
      cursor = res.body.nextCursor as string;
    }
    expect(seen).toHaveLength(8);
    expect(new Set(seen)).toEqual(
      new Set([
        'A-01-01', 'A-01-02', 'A-02-01', 'A-02-02',
        'B-01-01', 'B-01-02', 'B-02-01', 'B-02-02',
      ]),
    );
  });

  test('grid generation rejects collisions naming the first conflicting code with nothing committed', async () => {
    const { tenantId, token, warehouseId } = await setupTenantWithWarehouse();
    const zone = await createZone(token, tenantId, warehouseId, { code: 'A', name: 'Zone A' }).expect(201);
    const zoneId = zone.body.id as string;
    const grid = { aisleFrom: 'A', aisleTo: 'A', baysPerAisle: 1, levelsPerBay: 1, capacity: 10, type: 'floor' };
    await generateBins(token, tenantId, warehouseId, zoneId, grid).expect(201);

    // Overlapping run, fresh key: the first colliding code is named, and the
    // failed run commits nothing (no bins, no idempotency record).
    const overlapping = { ...grid, aisleTo: 'B', baysPerAisle: 2, levelsPerBay: 2 };
    const key = ulid();
    const res = await generateBins(token, tenantId, warehouseId, zoneId, overlapping, key).expect(409);
    expect(res.body).toMatchObject({ status: 409, code: 'duplicate-bin-code' });
    expect(res.body.detail).toContain('A-01-01');

    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql`select count(*)::int as n from bins where warehouse_id = ${warehouseId}`;
      expect(rows[0]!.n).toBe(1);
      const keys = await sql`select count(*)::int as n from idempotency_keys where key = ${key}`;
      expect(keys[0]!.n).toBe(0);
    } finally {
      await sql.end();
    }

    // Beyond the 500 cap → 422 grid-too-large.
    const huge = await generateBins(token, tenantId, warehouseId, zoneId, {
      aisleFrom: 'A',
      aisleTo: 'Z',
      baysPerAisle: 99,
      levelsPerBay: 99,
      capacity: 10,
      type: 'floor',
    }).expect(422);
    expect(huge.body).toMatchObject({ code: 'grid-too-large' });

    // A descending aisle range is a bad request, not an empty grid.
    const descending = await generateBins(token, tenantId, warehouseId, zoneId, {
      aisleFrom: 'B',
      aisleTo: 'A',
      baysPerAisle: 1,
      levelsPerBay: 1,
      capacity: 10,
      type: 'floor',
    }).expect(400);
    expect(descending.body).toMatchObject({ code: 'validation-failed' });
  });

  test('bin block toggle: 200 with the flag, replay re-serves, unknown bin 404, foreign session 403', async () => {
    const { tenantId, token, warehouseId } = await setupTenantWithWarehouse();
    const zone = await createZone(token, tenantId, warehouseId, { code: 'A', name: 'Zone A' }).expect(201);
    const bin = await createBin(token, tenantId, warehouseId, zone.body.id as string, {
      code: 'A-01-01',
      capacity: 120,
      type: 'shelf',
    }).expect(201);
    const binId = bin.body.id as string;
    const body = { blocked: true };
    const key = ulid();

    const blocked = await patchBin(token, tenantId, warehouseId, binId, body, key).expect(200);
    expect(blocked.body).toMatchObject({ id: binId, blocked: true });

    const replay = await patchBin(token, tenantId, warehouseId, binId, body, key).expect(200);
    expect(replay.body).toEqual(blocked.body);

    const unblocked = await patchBin(token, tenantId, warehouseId, binId, { blocked: false }).expect(200);
    expect(unblocked.body).toMatchObject({ id: binId, blocked: false });

    // Unknown bin in a known warehouse → 404 not-found.
    await patchBin(token, tenantId, warehouseId, uuidv7(), body).expect(404);

    // Foreign session → 403 permission-denied.
    const emailB = `owner-${ulid().toLowerCase()}@example.com`;
    const registeredB = await registerTenant(emailB).expect(201);
    createdTenantIds.push(registeredB.body.tenant.id);
    const tokenB = await signIn(emailB);
    const cross = await patchBin(tokenB, tenantId, warehouseId, binId, body).expect(403);
    expect(cross.body).toMatchObject({ code: 'permission-denied' });
  });

  test('the setup checklist is computed on read and checks off as steps are satisfied', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await registerTenant(email).expect(201);
    createdTenantIds.push(registered.body.tenant.id);
    const tenantId = registered.body.tenant.id as string;
    const token = await signIn(email);

    const fetchChecklist = async () =>
      request(app.getHttpServer())
        .get(`${IDENTITY_URL}/${tenantId}/setup-checklist`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

    const empty = await fetchChecklist();
    expect(empty.body.steps.map((s: { key: string }) => s.key)).toEqual([
      'warehouse',
      'bins',
      'catalog',
      'users',
    ]);
    expect(empty.body.steps.map((s: { done: boolean }) => s.done)).toEqual([false, false, false, false]);
    expect(empty.body.steps.every((s: { href: string }) => s.href === '/settings')).toBe(true);

    // Warehouse done after 1.2 …
    const warehouseId = await createWarehouseFor(tenantId, token);
    const afterWarehouse = await fetchChecklist();
    expect(afterWarehouse.body.steps.find((s: { key: string }) => s.key === 'warehouse').done).toBe(true);
    expect(afterWarehouse.body.steps.find((s: { key: string }) => s.key === 'bins').done).toBe(false);

    // … bins done once ≥ 1 bin exists; catalog/users stay honestly pending.
    const zone = await createZone(token, tenantId, warehouseId, { code: 'A', name: 'Zone A' }).expect(201);
    await createBin(token, tenantId, warehouseId, zone.body.id as string, {
      code: 'A-01-01',
      capacity: 120,
      type: 'shelf',
    }).expect(201);
    const afterBins = await fetchChecklist();
    expect(afterBins.body.steps.find((s: { key: string }) => s.key === 'bins').done).toBe(true);
    expect(afterBins.body.steps.find((s: { key: string }) => s.key === 'catalog').done).toBe(false);
    expect(afterBins.body.steps.find((s: { key: string }) => s.key === 'users').done).toBe(false);
  });

  test('zone and bin endpoints enforce tenant ownership (403) and require sessions (401)', async () => {
    const { tenantId, token, warehouseId } = await setupTenantWithWarehouse();
    await createZone(token, tenantId, warehouseId, { code: 'A', name: 'Zone A' }).expect(201);

    // No session → 401.
    await createZone(token, tenantId, warehouseId, { code: 'B', name: 'Zone B' })
      .unset('Authorization')
      .expect(401);

    const emailB = `owner-${ulid().toLowerCase()}@example.com`;
    const registeredB = await registerTenant(emailB).expect(201);
    createdTenantIds.push(registeredB.body.tenant.id);
    const tokenB = await signIn(emailB);

    const crossZone = await createZone(tokenB, tenantId, warehouseId, { code: 'B', name: 'Zone B' }).expect(403);
    expect(crossZone.body).toMatchObject({ code: 'permission-denied' });

    const crossList = await request(app.getHttpServer())
      .get(`${IDENTITY_URL}/${tenantId}/warehouses/${warehouseId}/zones`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(403);
    expect(crossList.body).toMatchObject({ code: 'permission-denied' });

    const crossChecklist = await request(app.getHttpServer())
      .get(`${IDENTITY_URL}/${tenantId}/setup-checklist`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(403);
    expect(crossChecklist.body).toMatchObject({ code: 'permission-denied' });

    // The zone/bin list of a nonexistent warehouse is 404, not an empty page.
    const missingWarehouse = await request(app.getHttpServer())
      .get(`${IDENTITY_URL}/${tenantId}/warehouses/${uuidv7()}/zones`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    expect(missingWarehouse.body).toMatchObject({ code: 'not-found' });
  });

  test('RLS: a tenant-scoped session cannot read another tenant’s zone or bin rows', async () => {
    const { tenantId: tenantA, token: tokenA, warehouseId } = await setupTenantWithWarehouse();
    const zoneA = await createZone(tokenA, tenantA, warehouseId, { code: 'A', name: 'Zone A' }).expect(201);
    await createBin(tokenA, tenantA, warehouseId, zoneA.body.id as string, {
      code: 'A-01-01',
      capacity: 120,
      type: 'shelf',
    }).expect(201);

    const emailB = `owner-${ulid().toLowerCase()}@example.com`;
    const registeredB = await registerTenant(emailB).expect(201);
    createdTenantIds.push(registeredB.body.tenant.id);
    const tenantB = registeredB.body.tenant.id as string;

    // Real non-superuser probe role (same pattern as the warehouses RLS test).
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

      // Zones: own read visible, foreign read empty, unscoped fail-closed.
      const ownZones = await scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
        return tx`select id from zones where tenant_id = ${tenantA}`;
      });
      expect(ownZones.length).toBe(1);

      const foreignZones = await scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantB}, true)`;
        return tx`select id from zones where tenant_id = ${tenantA}`;
      });
      expect(foreignZones).toHaveLength(0);

      const unscopedZones = await scoped`select id from zones where tenant_id = ${tenantA}`;
      expect(unscopedZones).toHaveLength(0);

      const foreignZoneInsert = scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
        await tx`insert into zones (id, tenant_id, warehouse_id, code, name)
          values (${uuidv7()}, ${tenantB}, ${warehouseId}, ${`RLS-${ulid().slice(0, 4)}`}, 'rls probe')`;
      });
      await expect(foreignZoneInsert).rejects.toThrow(/row-level security/i);

      // Bins: the same four probes against the second new table.
      const ownBins = await scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
        return tx`select id from bins where tenant_id = ${tenantA}`;
      });
      expect(ownBins.length).toBe(1);

      const foreignBins = await scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantB}, true)`;
        return tx`select id from bins where tenant_id = ${tenantA}`;
      });
      expect(foreignBins).toHaveLength(0);

      const unscopedBins = await scoped`select id from bins where tenant_id = ${tenantA}`;
      expect(unscopedBins).toHaveLength(0);

      const foreignBinInsert = scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
        await tx`insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type)
          values (${uuidv7()}, ${tenantB}, ${warehouseId}, ${zoneA.body.id}, ${`RLS-${ulid().slice(0, 4)}`}, 1, 'shelf')`;
      });
      await expect(foreignBinInsert).rejects.toThrow(/row-level security/i);
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
        '/tenants/{tenantId}/warehouses/{warehouseId}/zones',
        '/tenants/{tenantId}/warehouses/{warehouseId}/zones/{zoneId}/bins',
        '/tenants/{tenantId}/warehouses/{warehouseId}/zones/{zoneId}/bins/grid',
        '/tenants/{tenantId}/warehouses/{warehouseId}/bins/{binId}',
        '/tenants/{tenantId}/setup-checklist',
      ]),
    );
  });

  test('uuidv7 primitive keeps producing valid v7 ids (test-support sanity)', () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});