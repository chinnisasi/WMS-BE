import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { open as openSealed } from '../src/shared/crypto/envelope';
import { signDeviceToken, tenantSessionSecret } from '../src/modules/tenancy/jwt-session';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

// The e2e suite talks to the real Postgres (docker-compose dev DB by default;
// CI provides the service container) and signs sessions.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
// A host that exports either poll interval would boot the background workers
// and race these tests — the same convention as the reconciliation suite.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;

const IDENTITY_URL = '/api/v1/tenants';

function registrationBody(email: string): Record<string, unknown> {
  return { name: `Priya Spices ${email.split('@')[0]}`, ownerEmail: email, password: 'correct-horse-battery' };
}

describe('device enrollment, badge-in, revocation, self-test echo (e2e)', () => {
  let app: INestApplication;
  const createdTenantIds: string[] = [];

  let suiteDb: SuiteDatabase;

  beforeAll(async () => {
    // infra-1: this suite owns its own database (cloned from the template).
    suiteDb = await useSuiteDatabase('devices');
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
    await suiteDb.drop();
  });

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await sql.unsafe('DELETE FROM outbox_messages WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM devices WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
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

  async function signIn(email: string, password = 'correct-horse-battery'): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/sign-in`)
      .send({ email, password })
      .expect(200);
    return res.body.accessToken as string;
  }

  /** Invite + accept + sign-in: one active team member. */
  async function createMember(
    ownerToken: string,
    tenantId: string,
    role: string,
  ): Promise<{ userId: string; email: string; token: string }> {
    const email = `member-${ulid().toLowerCase()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', ulid())
      .send({ email, role })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/accept-invite`)
      .set('Idempotency-Key', ulid())
      .send({ token: invited.body.inviteToken, password: 'team-member-password' })
      .expect(200);
    const token = await signIn(email, 'team-member-password');
    return { userId: invited.body.user.id as string, email, token };
  }

  function mintCode(
    token: string,
    tenantId: string,
    idempotencyKey = ulid(),
  ): request.Test {
    return request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({});
  }

  function enroll(
    tenantId: string,
    body: Record<string, unknown>,
    idempotencyKey = ulid(),
  ): request.Test {
    return request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/devices/enroll`)
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
  }

  function badgeIn(
    tenantId: string,
    deviceToken: string,
    body: Record<string, unknown>,
  ): request.Test {
    return request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${deviceToken}`)
      .send(body);
  }

  function listDevices(token: string, tenantId: string, query: Record<string, unknown> = {}): request.Test {
    return request(app.getHttpServer())
      .get(`${IDENTITY_URL}/${tenantId}/devices`)
      .query(query)
      .set('Authorization', `Bearer ${token}`);
  }

  function revoke(
    token: string,
    tenantId: string,
    deviceId: string,
    idempotencyKey = ulid(),
  ): request.Test {
    return request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/devices/${deviceId}/revoke`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({});
  }

  function selfTestEcho(
    tenantId: string,
    sessionToken: string,
    body: Record<string, unknown>,
    idempotencyKey = ulid(),
  ): request.Test {
    return request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/devices/self-test/echo`)
      .set('Authorization', `Bearer ${sessionToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
  }

  /** Mint + enroll: one enrolled device with its credential + sealed key. */
  async function enrollDevice(
    ownerToken: string,
    tenantId: string,
    label: string,
  ): Promise<{
    deviceId: string;
    deviceToken: string;
    offlineStoreKeySealed: string;
  }> {
    const minted = await mintCode(ownerToken, tenantId).expect(201);
    const enrolled = await enroll(tenantId, {
      code: minted.body.code,
      label,
      pin: '1357',
    }).expect(201);
    return {
      deviceId: enrolled.body.device.id as string,
      deviceToken: enrolled.body.deviceToken as string,
      offlineStoreKeySealed: enrolled.body.offlineStoreKeySealed as string,
    };
  }

  async function badgeInOperator(
    tenantId: string,
    deviceToken: string,
    email: string,
    pin = '1357',
  ): Promise<{ accessToken: string; operator: { id: string; role: string } }> {
    const res = await badgeIn(tenantId, deviceToken, { operatorEmail: email, pin }).expect(200);
    return {
      accessToken: res.body.accessToken as string,
      operator: res.body.operator as { id: string; role: string },
    };
  }

  async function outboxRows(tenantId: string): Promise<{ type: string; payload: Record<string, unknown> }[]> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      return await sql<{ type: string; payload: Record<string, unknown> }[]>`
        select type, payload from outbox_messages where tenant_id = ${tenantId} order by created_at, id`;
    } finally {
      await sql.end();
    }
  }

  async function auditRows(tenantId: string): Promise<{ action: string; reference: string | null }[]> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      return await sql<{ action: string; reference: string | null }[]>`
        select action, reference from audit_events where tenant_id = ${tenantId} order by occurred_at, id`;
    } finally {
      await sql.end();
    }
  }

  test('minting a device enrollment code: 201 one-time 15-minute code, replay re-serves it, role-denied without device.manage', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId } = await registerTenant(email);
    const token = await signIn(email);

    const key = ulid();
    const first = await mintCode(token, tenantId, key).expect(201);
    expect(first.body.code).toBeTruthy();
    const ttl = Date.parse(first.body.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(15 * 60 * 1000);

    // Replay: same key re-serves the same one-time code.
    const replay = await mintCode(token, tenantId, key).expect(201);
    expect(replay.body).toEqual(first.body);

    // The mint writes the outbox event + audit row.
    const events = await outboxRows(tenantId);
    expect(events.filter((e) => e.type === 'device.enrollment_code_minted')).toHaveLength(1);
    const audits = await auditRows(tenantId);
    expect(audits.filter((a) => a.action === 'device.enrollment_code_minted')).toHaveLength(1);

    // An operator lacks device.manage — 403 role-denied.
    const operator = await createMember(token, tenantId, 'operator');
    const denied = await mintCode(operator.token, tenantId).expect(403);
    expect(denied.body).toMatchObject({ status: 403, code: 'role-denied' });
    expect(denied.body.detail).toContain('device.manage');

    // An ops_manager holds device.manage.
    const ops = await createMember(token, tenantId, 'ops_manager');
    await mintCode(ops.token, tenantId).expect(201);
  });

  test('enrollment: binds label + PIN, delivers a device credential + sealed offline-store key; second redemption fails indistinguishably', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId } = await registerTenant(email);
    const token = await signIn(email);

    const minted = await mintCode(token, tenantId).expect(201);
    const enrolled = await enroll(tenantId, {
      code: minted.body.code,
      label: 'Dock scanner 1',
      pin: '1357',
    }).expect(201);
    expect(enrolled.body.device).toMatchObject({ label: 'Dock scanner 1', tenantId });
    expect(enrolled.body.deviceToken).toBeTruthy();
    expect(enrolled.body.expiresInSeconds).toBeGreaterThan(15 * 60);

    // The sealed offline-store key opens to 32 random bytes (the sealed blob
    // is what travels — the raw key is never persisted server-side).
    const unwrapped = openSealed(enrolled.body.offlineStoreKeySealed);
    expect(unwrapped.length).toBe(32);

    // The device shows in the Settings list with its label and status.
    const listed = await listDevices(token, tenantId).expect(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({
      id: enrolled.body.device.id,
      label: 'Dock scanner 1',
      status: 'active',
      wipeFlag: false,
    });

    // A minted-but-unredeemed (pending) code is NOT a device yet — it never
    // appears in the list (the enrollment_code_hash filter).
    await mintCode(token, tenantId).expect(201);
    const afterPending = await listDevices(token, tenantId).expect(200);
    expect(
      afterPending.body.items.some((d: { label: string | null }) => d.label === null),
    ).toBe(false);
    expect(afterPending.body.items).toHaveLength(1);
    expect(
      afterPending.body.items.some((d: { label: string | null }) => d.label === null),
    ).toBe(false);

    // Second redemption of the same code → 400 enrollment-code-invalid.
    const second = await enroll(tenantId, {
      code: minted.body.code,
      label: 'Dock scanner 1 again',
      pin: '2468',
    }).expect(400);
    expect(second.body).toMatchObject({ status: 400, code: 'enrollment-code-invalid' });

    // Unknown code (well-formed 43-char base64url shape) — indistinguishable
    // from used/expired. A wrong-SHAPE code is a boundary validation-failed.
    const unknown = await enroll(tenantId, {
      code: 'bUp7d7w0B9DOrEmYlnMtdIXLCLiM1acwhLtIstaLYc8',
      label: 'X',
      pin: '1357',
    }).expect(400);
    expect(unknown.body).toMatchObject({ code: 'enrollment-code-invalid' });
    const wrongShape = await enroll(tenantId, { code: 'short', label: 'X', pin: '1357' }).expect(400);
    expect(wrongShape.body).toMatchObject({ code: 'validation-failed' });

    // A minted code offered on another tenant's path — one indistinguishable 400.
    const otherEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId: tenantB } = await registerTenant(otherEmail);
    const minted2 = await mintCode(token, tenantId).expect(201);
    const cross = await enroll(tenantB, {
      code: minted2.body.code,
      label: 'X',
      pin: '1357',
    }).expect(400);
    expect(cross.body).toMatchObject({ code: 'enrollment-code-invalid' });

    // Invalid PIN / label shapes are 400 validation-failed.
    const minted3 = await mintCode(token, tenantId).expect(201);
    await enroll(tenantId, { code: minted3.body.code, label: 'X', pin: '12345678' }).expect(400);
    const minted4 = await mintCode(token, tenantId).expect(201);
    await enroll(tenantId, { code: minted4.body.code, label: '', pin: '1357' }).expect(400);

    // Idempotent replay re-serves the original credential.
    const replayKey = ulid();
    const minted5 = await mintCode(token, tenantId).expect(201);
    const firstEnroll = await enroll(
      tenantId,
      { code: minted5.body.code, label: 'Replay scanner', pin: '1357' },
      replayKey,
    ).expect(201);
    const replayEnroll = await enroll(
      tenantId,
      { code: minted5.body.code, label: 'Replay scanner', pin: '1357' },
      replayKey,
    ).expect(201);
    expect(replayEnroll.body).toEqual(firstEnroll.body);
    // Same key, different payload → idempotency-key-reuse.
    const minted6 = await mintCode(token, tenantId).expect(201);
    const reuse = await enroll(
      tenantId,
      { code: minted6.body.code, label: 'Different label', pin: '1357' },
      replayKey,
    ).expect(422);
    expect(reuse.body).toMatchObject({ code: 'idempotency-key-reuse' });

    // Double-redeem race: two concurrent redemptions of one code — exactly one 201.
    const minted7 = await mintCode(token, tenantId).expect(201);
    const race = await Promise.all([
      enroll(tenantId, { code: minted7.body.code, label: 'Race A', pin: '1357' }),
      enroll(tenantId, { code: minted7.body.code, label: 'Race B', pin: '2468' }),
    ]);
    const statuses = race.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 400]);
    expect(race.find((r) => r.status === 400)!.body.code).toBe('enrollment-code-invalid');
  });

  test('expired-code redemption: a code past its expiresAt is the same indistinguishable 400', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId } = await registerTenant(email);
    const token = await signIn(email);

    const minted = await mintCode(token, tenantId).expect(201);

    // Backdate the pending row past its TTL (let a minted code "pass" its
    // expiresAt) — the redemption UPDATE re-checks expiry in its WHERE, so
    // this lands the same invalid-code 400 as an unknown/used code.
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await sql`update devices
        set enrollment_code_expires_at = now() - interval '1 minute'
        where tenant_id = ${tenantId}::uuid and enrollment_code_hash is not null`;
    } finally {
      await sql.end();
    }

    const expired = await enroll(tenantId, {
      code: minted.body.code,
      label: 'Late scanner',
      pin: '1357',
    }).expect(400);
    expect(expired.body).toMatchObject({ status: 400, code: 'enrollment-code-invalid' });

    // Nothing burned: the row still carries its (expired) hash — not redeemed.
    const listed = await listDevices(token, tenantId).expect(200);
    expect(listed.body.items).toHaveLength(0);
  });

  test('device list pagination: the keyset cursor chain walks to exhaustion without duplicates or gaps; malformed cursors 400', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId } = await registerTenant(email);
    const token = await signIn(email);

    // Five enrolled devices (distinct created_at ordering).
    const enrolledIds: string[] = [];
    for (const n of [1, 2, 3, 4, 5]) {
      const device = await enrollDevice(token, tenantId, `Cursor scanner ${n}`);
      enrolledIds.push(device.deviceId);
    }

    // Walk the chain with the returned cursors to exhaustion.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let hop = 0; ; hop++) {
      expect(hop).toBeLessThan(10); // the chain must terminate
      const query: Record<string, unknown> = { limit: 2 };
      if (cursor !== undefined) query.cursor = cursor;
      const page = await listDevices(token, tenantId, query).expect(200);
      seen.push(...page.body.items.map((d: { id: string }) => d.id));
      if (page.body.nextCursor === null) break;
      cursor = page.body.nextCursor as string;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5); // no duplicates
    expect(new Set(seen)).toEqual(new Set(enrolledIds)); // no gaps

    // A crafted cursor is a 400 invalid-cursor (same boundary as users/zones).
    await listDevices(token, tenantId, { cursor: 'not-a-real-cursor' }).expect(400);
  });

  test('badge-in: wrong operator/PIN is one indistinguishable 401; the operator-bound session drives the self-test echo', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId } = await registerTenant(email);
    const ownerToken = await signIn(email);
    const operator = await createMember(ownerToken, tenantId, 'operator');
    const device = await enrollDevice(ownerToken, tenantId, 'Badge scanner 1');

    // Wrong PIN → 401 badge-invalid; unknown operator — same code.
    const wrongPin = await badgeIn(tenantId, device.deviceToken, {
      operatorEmail: operator.email,
      pin: '9999',
    }).expect(401);
    expect(wrongPin.body).toMatchObject({ status: 401, code: 'badge-invalid' });
    const unknownOperator = await badgeIn(tenantId, device.deviceToken, {
      operatorEmail: `nobody-${ulid().toLowerCase()}@example.com`,
      pin: '1357',
    }).expect(401);
    expect(unknownOperator.body).toMatchObject({ code: 'badge-invalid' });

    // No device token / a garbage token → 401 unauthenticated.
    await request(app.getHttpServer())
      .post(`${IDENTITY_URL}/${tenantId}/devices/badge-in`)
      .send({ operatorEmail: operator.email, pin: '1357' })
      .expect(401);

    // A signed token naming a device that does not exist → 403 device-revoked.
    const ghost = signDeviceToken(tenantId, uuidv7(), tenantSessionSecret());
    await badgeIn(tenantId, ghost, { operatorEmail: operator.email, pin: '1357' }).expect(403);

    // A tenant-session token is not a device token (mutually exclusive claim shapes).
    await badgeIn(tenantId, ownerToken, { operatorEmail: operator.email, pin: '1357' }).expect(401);

    // Correct badge-in: 200 operator-bound session.
    const badged = await badgeInOperator(tenantId, device.deviceToken, operator.email);
    expect(badged.operator).toMatchObject({ id: operator.userId, role: 'operator' });

    // The first badge-in binds the device's operator (Settings list shows it).
    const listed = await listDevices(ownerToken, tenantId).expect(200);
    const boundDevice = listed.body.items.find(
      (d: { id: string }) => d.id === device.deviceId,
    );
    expect(boundDevice.operatorUserId).toBe(operator.userId);
    expect(boundDevice.operatorEmail).toBe(operator.email);
    expect(boundDevice.lastSeenAt).toBeTruthy();

    // A different operator cannot badge in on the bound device (single-operator).
    const secondOperator = await createMember(ownerToken, tenantId, 'operator');
    const other = await badgeIn(tenantId, device.deviceToken, {
      operatorEmail: secondOperator.email,
      pin: '1357',
    }).expect(401);
    expect(other.body).toMatchObject({ code: 'badge-invalid' });

    // The bare (pre-badge-in) credential cannot drive the echo surface.
    await selfTestEcho(tenantId, device.deviceToken, { payload: { kind: 'self-test' } }).expect(401);

    // The badge-in session can: echoed payload comes back with a receivedAt.
    const key = ulid();
    const echo = await selfTestEcho(
      tenantId,
      badged.accessToken,
      { payload: { kind: 'self-test', scan: 'SKU-1' } },
      key,
    ).expect(200);
    expect(echo.body).toMatchObject({
      deviceId: device.deviceId,
      operatorUserId: operator.userId,
      echoed: { kind: 'self-test', scan: 'SKU-1' },
    });
    expect(echo.body.receivedAt).toBeTruthy();

    // Replay: same key + payload re-serves the echo (settled exactly once).
    const replayEcho = await selfTestEcho(
      tenantId,
      badged.accessToken,
      { payload: { kind: 'self-test', scan: 'SKU-1' } },
      key,
    ).expect(200);
    expect(replayEcho.body).toEqual(echo.body);
    // Same key, different payload → idempotency-key-reuse.
    const reuse = await selfTestEcho(
      tenantId,
      badged.accessToken,
      { payload: { kind: 'self-test', scan: 'SKU-2' } },
      key,
    ).expect(422);
    expect(reuse.body).toMatchObject({ code: 'idempotency-key-reuse' });

    // A demoted operator is denied per command (role re-read from the DB).
    await request(app.getHttpServer())
      .patch(`${IDENTITY_URL}/${tenantId}/users/${operator.userId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', ulid())
      .send({ role: 'accountant' })
      .expect(200);
    const demoted = await selfTestEcho(
      tenantId,
      badged.accessToken,
      { payload: { kind: 'self-test' } },
    ).expect(403);
    expect(demoted.body).toMatchObject({ status: 403, code: 'role-denied' });
    expect(demoted.body.detail).toContain('accountant');
  });

  test('revocation: wipe-flagged, audited, outboxed, effective on the device\'s next request; re-revoke idempotent', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId } = await registerTenant(email);
    const ownerToken = await signIn(email);
    const operator = await createMember(ownerToken, tenantId, 'operator');
    const device = await enrollDevice(ownerToken, tenantId, 'Revoke scanner 1');
    const badged = await badgeInOperator(tenantId, device.deviceToken, operator.email);

    // Operator lacks device.manage.
    const denied = await revoke(operator.token, tenantId, device.deviceId).expect(403);
    expect(denied.body).toMatchObject({ status: 403, code: 'role-denied' });
    expect(denied.body.detail).toContain('device.manage');

    // Unknown device → 404.
    await revoke(ownerToken, tenantId, uuidv7()).expect(404);

    // Revoke: 200, revoked + wipe-flagged.
    const revoked = await revoke(ownerToken, tenantId, device.deviceId).expect(200);
    expect(revoked.body).toMatchObject({
      id: device.deviceId,
      status: 'revoked',
      wipeFlag: true,
    });
    expect(revoked.body.revokedAt).toBeTruthy();

    // Audit row + outbox event, exactly one each.
    const audits = await auditRows(tenantId);
    expect(audits.filter((a) => a.action === 'device.revoked')).toHaveLength(1);
    const events = await outboxRows(tenantId);
    expect(events.filter((e) => e.type === 'device.revoked')).toHaveLength(1);

    // Effective on the device's next request: badge-in and echo both 403
    // device-revoked.
    await badgeIn(tenantId, device.deviceToken, {
      operatorEmail: operator.email,
      pin: '1357',
    }).expect(403);
    const echo = await selfTestEcho(
      tenantId,
      badged.accessToken,
      { payload: { kind: 'self-test' } },
    ).expect(403);
    expect(echo.body).toMatchObject({ status: 403, code: 'device-revoked' });

    // Idempotent re-revoke: 200 same state, no second audit row / outbox event.
    const again = await revoke(ownerToken, tenantId, device.deviceId).expect(200);
    expect(again.body).toMatchObject({ status: 'revoked', wipeFlag: true });
    const auditsAfter = await auditRows(tenantId);
    expect(auditsAfter.filter((a) => a.action === 'device.revoked')).toHaveLength(1);
    const eventsAfter = await outboxRows(tenantId);
    expect(eventsAfter.filter((e) => e.type === 'device.revoked')).toHaveLength(1);

    // The Settings list still shows the revoked device (with its status).
    const listed = await listDevices(ownerToken, tenantId).expect(200);
    expect(
      listed.body.items.find((d: { id: string }) => d.id === device.deviceId).status,
    ).toBe('revoked');
  });

  test('replay re-authorization under revocation mid-queue: the echo re-resolves the device per call (fail-closed)', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId } = await registerTenant(email);
    const ownerToken = await signIn(email);
    const operator = await createMember(ownerToken, tenantId, 'operator');
    const device = await enrollDevice(ownerToken, tenantId, 'Mid-shift scanner');
    const badged = await badgeInOperator(tenantId, device.deviceToken, operator.email);

    // A queued op replays fine while active...
    await selfTestEcho(
      tenantId,
      badged.accessToken,
      { payload: { kind: 'self-test', op: 1 } },
    ).expect(200);

    // ...then revocation mid-queue fails the NEXT replayed op closed.
    await revoke(ownerToken, tenantId, device.deviceId).expect(200);
    const rejected = await selfTestEcho(
      tenantId,
      badged.accessToken,
      { payload: { kind: 'self-test', op: 2 } },
    ).expect(403);
    expect(rejected.body).toMatchObject({ code: 'device-revoked' });

    // The rejected op persisted nothing: no idempotency row, no settled echo.
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql<{ payload: Record<string, unknown> }[]>`
        select response_snapshot->>'echoed' as payload
        from idempotency_keys
        where tenant_id = ${tenantId} and response_snapshot ? 'echoed'`;
      expect(rows).toHaveLength(1); // only op 1 settled
    } finally {
      await sql.end();
    }
  });

  test('RLS: a non-superuser session cannot read another tenant\'s devices; the list is a member read', async () => {
    const emailA = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId: tenantA } = await registerTenant(emailA);
    const tokenA = await signIn(emailA);
    await enrollDevice(tokenA, tenantA, 'A scanner');

    const emailB = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId: tenantB } = await registerTenant(emailB);
    const tokenB = await signIn(emailB);

    // Foreign session → 403 permission-denied.
    const cross = await listDevices(tokenB, tenantA).expect(403);
    expect(cross.body).toMatchObject({ code: 'permission-denied' });

    // Real non-superuser probe: unscoped reads fail closed on devices.
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    let scoped: postgres.Sql<Record<string, unknown>> | undefined;
    try {
      await admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(742106)`;
        await tx.unsafe(`
          do $$ begin
            if not exists (select from pg_roles where rolname = 'wms_devices_rls_probe') then
              create role wms_devices_rls_probe login password 'wms_devices_rls_probe' nosuperuser;
            end if;
          end $$;
        `);
        await tx.unsafe('grant usage on schema public to wms_devices_rls_probe');
        await tx.unsafe(
          'grant select, insert, update, delete on all tables in schema public to wms_devices_rls_probe',
        );
      });
      const probeUrl = new URL(process.env.DATABASE_URL!);
      probeUrl.username = 'wms_devices_rls_probe';
      probeUrl.password = 'wms_devices_rls_probe';
      scoped = postgres(probeUrl.toString(), { max: 1 });
      const unscoped = await scoped`select id from devices where tenant_id = ${tenantA}`;
      expect(unscoped).toHaveLength(0);
      const foreignScoped = await scoped.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantB}, true)`;
        return tx`select id from devices where tenant_id = ${tenantA}`;
      });
      expect(foreignScoped).toHaveLength(0);
    } finally {
      await scoped?.end();
      await admin.end();
    }
  });

  test('the OpenAPI document exposes the devices contract (drift guard companion)', async () => {
    const committed = JSON.parse(
      readFileSync(resolve(process.cwd(), 'openapi/openapi.json'), 'utf8') as string,
    ) as { paths: Record<string, unknown> };
    expect(Object.keys(committed.paths)).toEqual(
      expect.arrayContaining([
        '/tenants/{tenantId}/devices/enrollment-codes',
        '/tenants/{tenantId}/devices/enroll',
        '/tenants/{tenantId}/devices/badge-in',
        '/tenants/{tenantId}/devices',
        '/tenants/{tenantId}/devices/{deviceId}/revoke',
        '/tenants/{tenantId}/devices/self-test/echo',
      ]),
    );
  });

  it('device enroll replays only within its OWN tenant — a foreign tenant holding the same idempotency key cannot hijack the credential', async () => {
    // The twin of the accept-invite case, and the worse one: this snapshot is
    // a DEVICE CREDENTIAL plus its sealed offline-store key. `idempotency_keys`
    // is unique per (tenant_id, key), not per key, so a replay lookup on `key`
    // alone reads another tenant's row — handing back their credential on a
    // payload-hash match, or 422-ing on a key this tenant never used.
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const { tenantId } = await registerTenant(email);
    const ownerToken = await signIn(email);

    const sharedKey = ulid();
    const seeder = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await seeder`
        insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot)
        values (
          ${uuidv7()}, ${uuidv7()}, ${sharedKey}, ${'b'.repeat(64)},
          ${seeder.json({ device: { id: uuidv7(), tenantId: uuidv7(), label: 'someone elses scanner' }, deviceToken: 'not-ours' })}
        )
      `;
    } finally {
      await seeder.end();
    }

    const minted = await mintCode(ownerToken, tenantId).expect(201);
    // Scoped to its own tenant this is a FIRST use: it must enroll for real,
    // not replay the foreign snapshot and not 422.
    const enrolled = await enroll(
      tenantId,
      { code: minted.body.code as string, label: `Shared-key scanner ${ulid()}`, pin: '2468' },
      sharedKey,
    ).expect(201);
    expect(enrolled.body.device.tenantId).toBe(tenantId);
    expect(enrolled.body.device.label).toContain('Shared-key scanner');
    expect(enrolled.body.deviceToken).not.toBe('not-ours');
  });
});
