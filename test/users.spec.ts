import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';

// The e2e suite talks to the real Postgres (docker-compose dev DB by default;
// CI provides the service container) and signs sessions.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
// A host that exports either poll interval would boot the background workers
// and race these tests — the same convention as the reconciliation suite.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;

const IDENTITY_URL = '/api/v1/tenants';
/** The invitee's own password (set at accept-invite, spec 1.5). */
const INVITEE_PASSWORD = 'team-member-password';
/** The documented import header (spec 1.4 Design Notes). */
const CSV_HEADER =
  'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';

function registrationBody(email: string): Record<string, unknown> {
  return { name: `Priya Spices ${email.split('@')[0]}`, ownerEmail: email, password: 'correct-horse-battery' };
}

function warehouseBody(code: string): Record<string, unknown> {
  return { code, name: `Whitefield ${ulid()}` };
}

function csvFile(rows: Record<string, string>[]): Buffer {
  const row = (values: Record<string, string>): string =>
    CSV_HEADER.split(',')
      .map((column) => values[column] ?? '')
      .join(',');
  return Buffer.from([CSV_HEADER, ...rows.map(row)].join('\n'), 'utf8');
}

describe('users, roles, and permission gating (e2e)', () => {
  let app: INestApplication;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    // Same deployment-parity auth probe as tenancy.spec.ts.
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      // Serialized across parallel jest workers: concurrent CREATE ROLE /
      // GRANT ON ALL TABLES from sibling suites trips "tuple concurrently
      // updated" on the shared catalog rows.
      await admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(742105)`;
        await tx.unsafe(`
          do $$ begin
            if not exists (select from pg_roles where rolname = 'wms_auth_probe') then
              create role wms_auth_probe login password 'wms_auth_probe' nosuperuser bypassrls;
            end if;
          end $$;
        `);
        await tx.unsafe('grant usage on schema public to wms_auth_probe');
        await tx.unsafe(
          'grant select, insert, update, delete on all tables in schema public to wms_auth_probe',
        );
      });
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
      // The suite's committed outbox rows must not linger (the relay
      // worker is env-gated OFF in tests — nothing drains them here).
      await sql.unsafe('DELETE FROM outbox_messages WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM catalog_import_errors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM catalog_imports WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM uom_conversions WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM skus WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM bins WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM zones WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM warehouses WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM tenants WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
    } finally {
      await sql.end();
    }
  }

  async function registerTenant(email: string): Promise<{ tenantId: string; ownerId: string }> {
    const res = await request(app.getHttpServer())
      .post(IDENTITY_URL)
      .set('Idempotency-Key', ulid())
      .send(registrationBody(email))
      .expect(201);
    createdTenantIds.push(res.body.tenant.id);
    return { tenantId: res.body.tenant.id as string, ownerId: res.body.owner.id as string };
  }

  async function signIn(email: string, password = 'correct-horse-battery'): Promise<{
    token: string;
    user: { id: string; email: string; role: string; status: string };
  }> {
    const res = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/sign-in`)
      .send({ email, password })
      .expect(200);
    return {
      token: res.body.accessToken as string,
      user: res.body.user as { id: string; email: string; role: string; status: string },
    };
  }

  function invite(
    token: string,
    tenantId: string,
    body: Record<string, unknown>,
    idempotencyKey = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/users`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
  }

  function listUsers(token: string, tenantId: string, query: Record<string, unknown> = {}): SupertestTest {
    return request(app.getHttpServer())
      .get(`${IDENTITY_URL}/${tenantId}/users`)
      .query(query)
      .set('Authorization', `Bearer ${token}`);
  }

  function setUserRole(
    token: string,
    tenantId: string,
    userId: string,
    body: Record<string, unknown>,
    idempotencyKey = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .patch(`${IDENTITY_URL}/${tenantId}/users/${userId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
  }

  function acceptInvite(
    tenantId: string,
    body: Record<string, unknown>,
    idempotencyKey = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/accept-invite`)
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
  }

  function me(token: string, tenantId: string): SupertestTest {
    return request(app.getHttpServer())
      .get(`${IDENTITY_URL}/${tenantId}/me`)
      .set('Authorization', `Bearer ${token}`);
  }

  function createWarehouse(token: string, tenantId: string, idempotencyKey = ulid()): SupertestTest {
    return request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(warehouseBody(`BLR-${ulid().slice(10, 16).toUpperCase()}`));
  }

  function createZone(
    token: string,
    tenantId: string,
    warehouseId: string,
    body: Record<string, unknown>,
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/warehouses/${warehouseId}/zones`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', ulid())
      .send(body);
  }

  function createBin(
    token: string,
    tenantId: string,
    warehouseId: string,
    zoneId: string,
    body: Record<string, unknown>,
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', ulid())
      .send(body);
  }

  function importCatalog(
    token: string,
    tenantId: string,
    rows: Record<string, string>[],
    mode: string,
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', ulid())
      .field('mode', mode)
      .attach('file', csvFile(rows), { filename: 'catalog.csv', contentType: 'text/csv' });
  }

  function listSkus(token: string, tenantId: string): SupertestTest {
    return request(app.getHttpServer())
      .get(`${IDENTITY_URL}/${tenantId}/catalog/skus`)
      .set('Authorization', `Bearer ${token}`);
  }

  /** Invite + accept + sign-in: one active team member. */
  async function createMember(
    ownerToken: string,
    tenantId: string,
    role: string,
  ): Promise<{ userId: string; email: string; token: string }> {
    const email = `member-${ulid().toLowerCase()}@example.com`;
    const invited = await invite(ownerToken, tenantId, { email, role }).expect(201);
    const accepted = await acceptInvite(tenantId, {
      token: invited.body.inviteToken,
      password: INVITEE_PASSWORD,
    }).expect(200);
    const signedIn = await signIn(email, INVITEE_PASSWORD);
    return { userId: accepted.body.user.id as string, email, token: signedIn.token };
  }

  async function auditRows(
    tenantId: string,
  ): Promise<{ action: string; actor_user_id: string; reference: string | null }[]> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      return await sql<{ action: string; actor_user_id: string; reference: string | null }[]>`
        select action, actor_user_id, reference
        from audit_events where tenant_id = ${tenantId} order by occurred_at, id`;
    } finally {
      await sql.end();
    }
  }

  test('sign-in carries the user shape (id, email, role, status)', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId, ownerId } = await registerTenant(email);
    const { user } = await signIn(email);
    expect(user).toEqual({
      id: ownerId,
      email,
      role: 'owner',
      status: 'active',
      createdAt: expect.any(String),
    });
    expect(tenantId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('owner invites a user: 201 invited + one-time 7-day token, audit row, replay re-serves the token', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId } = await registerTenant(email);
    const { token } = await signIn(email);

    const inviteeEmail = `invitee-${ulid().toLowerCase()}@example.com`;
    const key = ulid();
    const first = await invite(token, tenantId, { email: inviteeEmail, role: 'operator' }, key).expect(201);
    expect(first.body.user).toMatchObject({
      email: inviteeEmail,
      role: 'operator',
      status: 'invited',
    });
    expect(first.body.inviteToken).toBeTruthy();
    // 7-day expiry (spec 1.5).
    const ttl = Date.parse(first.body.inviteExpiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
    expect(ttl).toBeLessThanOrEqual(7 * 24 * 3600 * 1000);

    // Replay: same key + same body re-serves the original response (same
    // one-time link — a retried invite must not mint a second token).
    const replay = await invite(token, tenantId, { email: inviteeEmail, role: 'operator' }, key).expect(201);
    expect(replay.body).toEqual(first.body);

    // Same key, different payload → idempotency-key-reuse.
    const reuse = await invite(token, tenantId, { email: inviteeEmail, role: 'ops_manager' }, key).expect(422);
    expect(reuse.body).toMatchObject({ code: 'idempotency-key-reuse' });

    // Exactly one user row for the invitee despite the replay.
    const listed = await listUsers(token, tenantId).expect(200);
    expect(listed.body.items.filter((u: { email: string }) => u.email === inviteeEmail)).toHaveLength(1);

    // Audit row in the same transaction as the mutation: actor, action,
    // idempotency reference (the target row + timestamp live in the row).
    const rows = await auditRows(tenantId);
    const invitedRow = rows.find((row) => row.action === 'user.invited');
    expect(invitedRow).toMatchObject({ reference: key });
    expect(invitedRow!.actor_user_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('duplicate email (any tenant) is 409 email-exists; a non-owner caller is 403 role-denied', async () => {
    const emailA = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId: tenantA } = await registerTenant(emailA);
    const { token: tokenA } = await signIn(emailA);
    const emailB = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId: tenantB } = await registerTenant(emailB);
    const { token: tokenB } = await signIn(emailB);

    // Invite an email that already has an account (tenant B's owner) —
    // emails are globally unique across tenants.
    const dup = await invite(tokenA, tenantA, { email: emailB, role: 'operator' }).expect(409);
    expect(dup.headers['content-type']).toContain('application/problem+json');
    expect(dup.body).toMatchObject({ status: 409, code: 'email-exists' });
    expect(dup.body.detail).toContain(emailB);

    // Re-inviting a pending invitee from the same tenant — still email-exists.
    const inviteeEmail = `invitee-${ulid().toLowerCase()}@example.com`;
    await invite(tokenA, tenantA, { email: inviteeEmail, role: 'operator' }).expect(201);
    const dup2 = await invite(tokenA, tenantA, { email: inviteeEmail, role: 'operator' }).expect(409);
    expect(dup2.body).toMatchObject({ code: 'email-exists' });

    // A non-owner caller lacks users.invite — 403 role-denied naming the
    // role and the capability.
    const member = await createMember(tokenA, tenantA, 'ops_manager');
    const denied = await invite(member.token, tenantA, {
      email: `invitee-${ulid().toLowerCase()}@example.com`,
      role: 'operator',
    }).expect(403);
    expect(denied.body).toMatchObject({ status: 403, code: 'role-denied' });
    expect(denied.body.detail).toContain('ops_manager');
    expect(denied.body.detail).toContain('users.invite');

    // Tenant B's owner inviting tenant A's owner email — also email-exists.
    const cross = await invite(tokenB, tenantB, { email: emailA, role: 'operator' }).expect(409);
    expect(cross.body).toMatchObject({ code: 'email-exists' });
  });

  test('sign-in before accepting is 403 invite-pending; accept sets password + activates; token is one-time', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId } = await registerTenant(email);
    const { token } = await signIn(email);
    const inviteeEmail = `invitee-${ulid().toLowerCase()}@example.com`;
    const invited = await invite(token, tenantId, { email: inviteeEmail, role: 'operator' }).expect(201);
    const inviteToken = invited.body.inviteToken as string;

    // Sign-in as an invited user → 403 invite-pending, with ANY password.
    const pending = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/sign-in`)
      .send({ email: inviteeEmail, password: 'whatever-password' })
      .expect(403);
    expect(pending.body).toMatchObject({ code: 'invite-pending' });

    // Unknown token → 400 invite-invalid (unknown/used/expired are
    // indistinguishable).
    const unknown = await acceptInvite(tenantId, { token: 'no-such-token', password: INVITEE_PASSWORD }).expect(400);
    expect(unknown.body).toMatchObject({ status: 400, code: 'invite-invalid' });

    // Accept: sets the invitee's own password, status → active.
    const accepted = await acceptInvite(tenantId, { token: inviteToken, password: INVITEE_PASSWORD }).expect(200);
    expect(accepted.body.user).toMatchObject({ email: inviteeEmail, role: 'operator', status: 'active' });

    // The token is one-time: reuse → 400 invite-invalid.
    const reuse = await acceptInvite(tenantId, { token: inviteToken, password: 'another-password' }).expect(400);
    expect(reuse.body).toMatchObject({ code: 'invite-invalid' });

    // Replay of the accepted request (same key + same body) re-serves the
    // snapshot — even though the token is now burned.
    const acceptKey = ulid();
    const secondEmail = `invitee-${ulid().toLowerCase()}@example.com`;
    const second = await invite(token, tenantId, { email: secondEmail, role: 'operator' }).expect(201);
    const firstAccept = await acceptInvite(
      tenantId,
      { token: second.body.inviteToken, password: INVITEE_PASSWORD },
      acceptKey,
    ).expect(200);
    const replayAccept = await acceptInvite(
      tenantId,
      { token: second.body.inviteToken, password: INVITEE_PASSWORD },
      acceptKey,
    ).expect(200);
    expect(replayAccept.body).toEqual(firstAccept.body);

    // The accepted user signs in with their own password; the session
    // reflects the new status.
    const signedIn = await signIn(inviteeEmail, INVITEE_PASSWORD);
    expect(signedIn.user.status).toBe('active');
    expect(signedIn.user.role).toBe('operator');
  });

  test('role change is audited and applies on the user’s next command without re-login', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId } = await registerTenant(email);
    const { token: ownerToken } = await signIn(email);
    const member = await createMember(ownerToken, tenantId, 'ops_manager');

    // ops_manager can create a warehouse …
    await createWarehouse(member.token, tenantId).expect(201);

    // … the owner demotes them to operator …
    const changed = await setUserRole(ownerToken, tenantId, member.userId, { role: 'operator' }).expect(200);
    expect(changed.body).toMatchObject({ id: member.userId, role: 'operator', email: member.email });

    // … and the SAME session (no re-login) is denied on their next command —
    // authority is re-read from the DB, never a JWT claim.
    const denied = await createWarehouse(member.token, tenantId).expect(403);
    expect(denied.body).toMatchObject({ code: 'role-denied' });
    expect(denied.body.detail).toContain('operator');
    expect(denied.body.detail).toContain('warehouse.create');

    // Audit row for the role change, with the idempotency reference.
    const rows = await auditRows(tenantId);
    expect(rows.filter((row) => row.action === 'user.role_changed')).toHaveLength(1);

    // Replay: the same key + payload re-serves the 200 response.
    const changeKey = ulid();
    const promoteBody = { role: 'ops_manager' };
    const promoted = await setUserRole(ownerToken, tenantId, member.userId, promoteBody, changeKey).expect(200);
    const replay = await setUserRole(ownerToken, tenantId, member.userId, promoteBody, changeKey).expect(200);
    expect(replay.body).toEqual(promoted.body);
    // Same key, different payload → idempotency-key-reuse.
    const reuse = await setUserRole(ownerToken, tenantId, member.userId, { role: 'operator' }, changeKey).expect(422);
    expect(reuse.body).toMatchObject({ code: 'idempotency-key-reuse' });

    // Unknown target user → 404 not-found.
    const missing = await setUserRole(ownerToken, tenantId, uuidv7(), { role: 'operator' }).expect(404);
    expect(missing.body).toMatchObject({ code: 'not-found' });
  });

  test('the last Owner cannot be demoted (409 last-owner, nothing persisted) but a second Owner unlocks it', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId, ownerId } = await registerTenant(email);
    const { token: ownerToken } = await signIn(email);

    const lastOwner = await setUserRole(ownerToken, tenantId, ownerId, { role: 'operator' }).expect(409);
    expect(lastOwner.headers['content-type']).toContain('application/problem+json');
    expect(lastOwner.body).toMatchObject({ status: 409, code: 'last-owner' });

    // No mutation persisted: the owner is still owner.
    const users = await listUsers(ownerToken, tenantId).expect(200);
    const owner = users.body.items.find((u: { id: string }) => u.id === ownerId);
    expect(owner.role).toBe('owner');

    // Invite a member, promote them to owner, then demoting them works.
    const second = await createMember(ownerToken, tenantId, 'operator');
    await setUserRole(ownerToken, tenantId, second.userId, { role: 'owner' }).expect(200);
    await setUserRole(ownerToken, tenantId, second.userId, { role: 'ops_manager' }).expect(200);

    // A non-owner caller cannot change roles at all (users.role_change).
    const member = await createMember(ownerToken, tenantId, 'ops_manager');
    const denied = await setUserRole(member.token, tenantId, member.userId, { role: 'operator' }).expect(403);
    expect(denied.body).toMatchObject({ code: 'role-denied' });
    expect(denied.body.detail).toContain('users.role_change');
  });

  test('users list is a read (open to any member), cursor-paginated; /me echoes the caller', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId, ownerId } = await registerTenant(email);
    const { token: ownerToken } = await signIn(email);
    const member = await createMember(ownerToken, tenantId, 'accountant');

    // A read-only role can list users and read /me (reads are never gated).
    const listed = await listUsers(member.token, tenantId).expect(200);
    expect(listed.body.items).toHaveLength(2);
    expect(listed.body.nextCursor).toBeNull();
    const meRes = await request(app.getHttpServer())
      .get(`${IDENTITY_URL}/${tenantId}/me`)
      .set('Authorization', `Bearer ${member.token}`)
      .expect(200);
    expect(meRes.body.user).toMatchObject({ email: member.email, role: 'accountant', status: 'active' });

    // Keyset paging walks both users exactly once.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const res = await listUsers(ownerToken, tenantId, cursor === undefined ? { limit: 1 } : { limit: 1, cursor }).expect(200);
      seen.push(...res.body.items.map((u: { id: string }) => u.id));
      if (res.body.nextCursor === null) break;
      cursor = res.body.nextCursor as string;
    }
    expect(seen).toHaveLength(2);
    expect(seen).toContain(ownerId);
    expect(seen).toContain(member.userId);

    const malformed = await listUsers(ownerToken, tenantId, { cursor: 'not-a-cursor' }).expect(400);
    expect(malformed.body).toMatchObject({ code: 'invalid-cursor' });

    // Foreign session → 403 permission-denied on both reads.
    const emailB = `owner-${ulid().toLowerCase()}@example.com`;
    await registerTenant(emailB);
    const { token: tokenB } = await signIn(emailB);
    const cross = await listUsers(tokenB, tenantId).expect(403);
    expect(cross.body).toMatchObject({ code: 'permission-denied' });
    await me(tokenB, tenantId).expect(403);
  });

  test('gated mutations: operator denied, ops_manager passes operationally, reads stay open', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId } = await registerTenant(email);
    const { token: ownerToken } = await signIn(email);

    // Owner can do everything, including user management.
    const warehouse = await createWarehouse(ownerToken, tenantId).expect(201);
    const warehouseId = warehouse.body.id as string;
    const zone = await createZone(ownerToken, tenantId, warehouseId, { code: 'A', name: 'Zone A' }).expect(201);
    const zoneId = zone.body.id as string;
    await importCatalog(ownerToken, tenantId, [
      { sku_code: 'SKU-1', name: 'Turmeric', uom: 'pcs', gst_rate: '1800' },
    ], 'initial').expect(201);

    // Operator: every gated mutation is 403 role-denied; reads succeed.
    const operator = await createMember(ownerToken, tenantId, 'operator');
    const deniedWarehouse = await createWarehouse(operator.token, tenantId).expect(403);
    expect(deniedWarehouse.headers['content-type']).toContain('application/problem+json');
    expect(deniedWarehouse.body).toMatchObject({ status: 403, code: 'role-denied' });
    expect(deniedWarehouse.body.detail).toContain('operator');
    expect(deniedWarehouse.body.detail).toContain('warehouse.create');

    const deniedZone = await createZone(operator.token, tenantId, warehouseId, { code: 'B', name: 'Zone B' }).expect(403);
    expect(deniedZone.body).toMatchObject({ code: 'role-denied' });
    expect(deniedZone.body.detail).toContain('zone.create');

    const deniedBin = await createBin(operator.token, tenantId, warehouseId, zoneId, {
      code: 'A-01-01',
      capacity: 10,
      type: 'shelf',
    }).expect(403);
    expect(deniedBin.body).toMatchObject({ code: 'role-denied' });

    const deniedImport = await importCatalog(operator.token, tenantId, [
      { sku_code: 'SKU-2', name: 'Pepper', uom: 'pcs', gst_rate: '500' },
    ], 'initial').expect(403);
    expect(deniedImport.body).toMatchObject({ code: 'role-denied' });
    expect(deniedImport.body.detail).toContain('catalog.import');

    // The remaining three gates, pinned the same way: bin.block, bin.create
    // (grid generation), sku.edit — removing any of these asserts fails CI.
    const ownerBin = await createBin(ownerToken, tenantId, warehouseId, zoneId, {
      code: 'A-01-01',
      capacity: 10,
      type: 'shelf',
    }).expect(201);

    const deniedBlock = await request(app.getHttpServer())
      .patch(`${IDENTITY_URL}/${tenantId}/warehouses/${warehouseId}/bins/${ownerBin.body.id}`)
      .set('Authorization', `Bearer ${operator.token}`)
      .set('Idempotency-Key', ulid())
      .send({ blocked: true })
      .expect(403);
    expect(deniedBlock.body).toMatchObject({ code: 'role-denied' });
    expect(deniedBlock.body.detail).toContain('bin.block');

    const deniedGrid = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins/grid`)
      .set('Authorization', `Bearer ${operator.token}`)
      .set('Idempotency-Key', ulid())
      .send({ aisleFrom: 'C', aisleTo: 'D', baysPerAisle: 2, levelsPerBay: 2, capacity: 10, type: 'shelf' })
      .expect(403);
    expect(deniedGrid.body).toMatchObject({ code: 'role-denied' });
    expect(deniedGrid.body.detail).toContain('bin.create');

    const operatorSkus = await listSkus(operator.token, tenantId).expect(200);
    const sku1 = operatorSkus.body.items.find((s: { code: string }) => s.code === 'SKU-1');
    const deniedSkuEdit = await request(app.getHttpServer())
      .patch(`${IDENTITY_URL}/${tenantId}/catalog/skus/${sku1.id}`)
      .set('Authorization', `Bearer ${operator.token}`)
      .set('Idempotency-Key', ulid())
      .send({ name: 'Turmeric powder' })
      .expect(403);
    expect(deniedSkuEdit.body).toMatchObject({ code: 'role-denied' });
    expect(deniedSkuEdit.body.detail).toContain('sku.edit');

    // … and the denied import committed nothing (no partial writes).
    const skus = await listSkus(operator.token, tenantId).expect(200);
    expect(skus.body.items.map((s: { code: string }) => s.code)).toEqual(['SKU-1']);

    // Reads are open to any tenant member — lists and the checklist.
    await request(app.getHttpServer())
      .get(`${IDENTITY_URL}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${operator.token}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`${IDENTITY_URL}/${tenantId}/setup-checklist`)
      .set('Authorization', `Bearer ${operator.token}`)
      .expect(200);

    // ops_manager: all operational mutations pass, user management does not.
    const opsManager = await createMember(ownerToken, tenantId, 'ops_manager');
    const opsWarehouse = await createWarehouse(opsManager.token, tenantId).expect(201);
    const opsWarehouseId = opsWarehouse.body.id as string;
    const opsZone = await createZone(opsManager.token, tenantId, opsWarehouseId, { code: 'A', name: 'Zone A' }).expect(201);
    await createBin(opsManager.token, tenantId, opsWarehouseId, opsZone.body.id as string, {
      code: 'A-01-01',
      capacity: 10,
      type: 'shelf',
    }).expect(201);
    await importCatalog(opsManager.token, tenantId, [
      { sku_code: 'SKU-2', name: 'Cumin', uom: 'pcs', gst_rate: '500' },
    ], 'initial').expect(201);
    const skuList = await listSkus(opsManager.token, tenantId).expect(200);
    const sku2 = skuList.body.items.find((s: { code: string }) => s.code === 'SKU-2');
    await request(app.getHttpServer())
      .patch(`${IDENTITY_URL}/${tenantId}/catalog/skus/${sku2.id}`)
      .set('Authorization', `Bearer ${opsManager.token}`)
      .set('Idempotency-Key', ulid())
      .send({ name: 'Cumin seeds' })
      .expect(200);

    const deniedInvite = await invite(opsManager.token, tenantId, {
      email: `invitee-${ulid().toLowerCase()}@example.com`,
      role: 'operator',
    }).expect(403);
    expect(deniedInvite.body.detail).toContain('users.invite');
    const deniedRole = await setUserRole(opsManager.token, tenantId, operator.userId, { role: 'owner' }).expect(403);
    expect(deniedRole.body.detail).toContain('users.role_change');
  });

  test('the checklist users step checks off once a non-owner user exists', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId } = await registerTenant(email);
    const { token } = await signIn(email);

    const fetchChecklist = async () =>
      request(app.getHttpServer())
        .get(`${IDENTITY_URL}/${tenantId}/setup-checklist`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

    const before = await fetchChecklist();
    expect(before.body.steps.find((s: { key: string }) => s.key === 'users').done).toBe(false);

    // An invited (not yet accepted) non-owner user already counts.
    await invite(token, tenantId, { email: `invitee-${ulid().toLowerCase()}@example.com`, role: 'operator' }).expect(201);
    const after = await fetchChecklist();
    const usersStep = after.body.steps.find((s: { key: string }) => s.key === 'users');
    expect(usersStep.done).toBe(true);
    expect(usersStep.detail).toMatch(/^Done · 1 team member/);
  });

  test('RLS: a non-superuser session cannot read audit_events (or users) of another tenant', async () => {
    const emailA = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId: tenantA } = await registerTenant(emailA);
    const { token: tokenA } = await signIn(emailA);
    await createMember(tokenA, tenantA, 'operator'); // writes user.invited audit rows

    const emailB = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId: tenantB } = await registerTenant(emailB);

    // Real non-superuser probe role (same pattern as the warehouses RLS test).
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    let scoped: postgres.Sql<Record<string, unknown>> | undefined;
    try {
      // Serialized across parallel jest workers like the beforeAll probe:
      // concurrent CREATE ROLE / GRANT ON ALL TABLES from sibling suites trip
      // "tuple concurrently updated" on the shared catalog rows.
      await admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(742105)`;
        await tx.unsafe(`
          do $$ begin
            if not exists (select from pg_roles where rolname = 'wms_rls_probe') then
              create role wms_rls_probe login password 'wms_rls_probe' nosuperuser;
            end if;
          end $$;
        `);
        await tx.unsafe('grant usage on schema public to wms_rls_probe');
        await tx.unsafe(
          'grant select, insert, update, delete on all tables in schema public to wms_rls_probe',
        );
      });
      const probeUrl = new URL(process.env.DATABASE_URL!);
      probeUrl.username = 'wms_rls_probe';
      probeUrl.password = 'wms_rls_probe';
      scoped = postgres(probeUrl.toString(), { max: 1 });

      // audit_events: own read visible, foreign read empty, unscoped fail-closed.
      const ownAudit = await scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
        return tx`select id from audit_events where tenant_id = ${tenantA}`;
      });
      expect(ownAudit.length).toBeGreaterThanOrEqual(1);

      const foreignAudit = await scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantB}, true)`;
        return tx`select id from audit_events where tenant_id = ${tenantA}`;
      });
      expect(foreignAudit).toHaveLength(0);

      const unscopedAudit = await scoped`select id from audit_events where tenant_id = ${tenantA}`;
      expect(unscopedAudit).toHaveLength(0);

      // The WRITE side is fail-closed too: the policy's WITH CHECK rejects an
      // INSERT stamped with a foreign tenant_id.
      const foreignAuditInsert = scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
        await tx`insert into audit_events (id, tenant_id, actor_user_id, action, target_type, target_id)
          values (${uuidv7()}, ${tenantB}, ${uuidv7()}, 'user.invited', 'user', ${uuidv7()})`;
      });
      await expect(foreignAuditInsert).rejects.toThrow(/row-level security/i);

      // users: the new role/status/invite columns live on the already-
      // isolated table — the foreign read still fails closed.
      const foreignUsers = await scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantB}, true)`;
        return tx`select id, role, status from users where tenant_id = ${tenantA}`;
      });
      expect(foreignUsers).toHaveLength(0);
    } finally {
      await scoped?.end();
      await admin.end();
    }
  });

  test('the OpenAPI document exposes the users contract (drift guard companion)', async () => {
    const committed = JSON.parse(
      readFileSync(resolve(process.cwd(), 'openapi/openapi.json'), 'utf8') as string,
    ) as { paths: Record<string, unknown> };
    expect(Object.keys(committed.paths)).toEqual(
      expect.arrayContaining([
        '/tenants/{tenantId}/users',
        '/tenants/{tenantId}/users/{userId}',
        '/tenants/{tenantId}/accept-invite',
        '/tenants/{tenantId}/me',
      ]),
    );
  });
});
