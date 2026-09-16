import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { openCredential } from '../src/modules/carriers/carrier-credentials';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

// The e2e suite talks to the real Postgres (docker-compose dev DB by default;
// CI provides the service container) and signs sessions.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.CARRIER_ENCRYPTION_KEY ??= 'e2e-only-carrier-encryption-key-0123456789abcdef';
// A host that exports either poll interval would boot the background workers
// and race these tests — the same convention as the sibling suites.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

/**
 * The fixture credentials. Every one of these strings is a canary: the
 * confinement test greps the stored row, the outbox payload, the audit row,
 * the idempotency snapshot and every response body for them, so they are
 * deliberately distinctive rather than realistic.
 */
const DELHIVERY_CREDENTIAL = {
  apiToken: 'canary-delhivery-token-f3a91c',
  clientName: 'canary-delhivery-client',
};
const DELHIVERY_ROTATED = {
  apiToken: 'canary-delhivery-rotated-8be204',
  clientName: 'canary-delhivery-client',
};

describe('carrier adapter registry + tenant credential vault (e2e)', () => {
  let app: INestApplication;
  const createdTenantIds: string[] = [];
  let suiteDb: SuiteDatabase;

  beforeAll(async () => {
    // infra-1: this suite owns its own database (cloned from the template).
    suiteDb = await useSuiteDatabase('carriers');
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
      for (const table of [
        'carrier_connections',
        'outbox_messages',
        'idempotency_keys',
        'audit_events',
        'users',
        'tenants',
      ]) {
        await sql.unsafe(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [
          createdTenantIds,
        ]);
      }
    } finally {
      await sql.end();
    }
  }

  function db(): postgres.Sql<Record<string, unknown>> {
    return postgres(process.env.DATABASE_URL!, { max: 1 });
  }

  async function signIn(email: string, password = 'correct-horse-battery'): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`${API}/sign-in`)
      .send({ email, password })
      .expect(200);
    return res.body.accessToken as string;
  }

  /** A brand-new tenant per scenario: one connection per (tenant, carrier). */
  async function freshTenant(): Promise<{ tenantId: string; ownerId: string; token: string }> {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const res = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({
        name: `Priya Spices ${email.split('@')[0]}`,
        ownerEmail: email,
        password: 'correct-horse-battery',
      })
      .expect(201);
    createdTenantIds.push(res.body.tenant.id as string);
    return {
      tenantId: res.body.tenant.id as string,
      ownerId: res.body.owner.id as string,
      token: await signIn(email),
    };
  }

  /** Invite + accept + sign-in: one active team member in the given role. */
  async function createMember(
    ownerToken: string,
    tenantId: string,
    role: string,
  ): Promise<{ userId: string; token: string }> {
    const email = `member-${ulid().toLowerCase()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken, password: 'team-member-password' })
      .expect(200);
    return {
      userId: invited.body.user.id as string,
      token: await signIn(email, 'team-member-password'),
    };
  }

  function connect(
    token: string,
    tenantId: string,
    body: Record<string, unknown>,
    key = ulid(),
  ): request.Test {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/carriers/connections`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function rotate(
    token: string,
    tenantId: string,
    connectionId: string,
    credential: unknown,
    key = ulid(),
  ): request.Test {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/carriers/connections/${connectionId}/rotate`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ credential });
  }

  function disconnect(
    token: string,
    tenantId: string,
    connectionId: string,
    key = ulid(),
  ): request.Test {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/carriers/connections/${connectionId}/disconnect`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({});
  }

  function listConnections(token: string, tenantId: string, query = ''): request.Test {
    return request(app.getHttpServer())
      .get(`${API}/${tenantId}/carriers/connections${query}`)
      .set('Authorization', `Bearer ${token}`);
  }

  const delhiveryBody = (label = 'Delhivery — Mumbai'): Record<string, unknown> => ({
    carrierCode: 'delhivery',
    accountLabel: label,
    credential: { ...DELHIVERY_CREDENTIAL },
  });

  // ── the registry ───────────────────────────────────────────────────────────

  it('the catalogue names the three direct carriers and what each one needs', async () => {
    const { tenantId, token } = await freshTenant();
    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/carriers`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const items = res.body.items as {
      code: string;
      displayName: string;
      credentialFields: { name: string; required: boolean }[];
    }[];
    expect(items.map((item) => item.code)).toEqual(['blue_dart', 'delhivery', 'ecom_express']);
    // OQ1's decision: Shiprocket is an AGGREGATOR and is deliberately out.
    expect(items.map((item) => item.code)).not.toContain('shiprocket');

    const delhivery = items.find((item) => item.code === 'delhivery')!;
    expect(delhivery.displayName).toBe('Delhivery');
    expect(delhivery.credentialFields.map((field) => field.name)).toEqual([
      'apiToken',
      'clientName',
    ]);
    expect(delhivery.credentialFields.every((field) => field.required)).toBe(true);
    // The catalogue is how a surface learns what to ask for — every field
    // carries a label and a description, not just a name.
    for (const item of items) {
      expect(item.credentialFields.length).toBeGreaterThan(0);
      for (const field of item.credentialFields) {
        expect(typeof (field as unknown as { label: string }).label).toBe('string');
        expect(typeof (field as unknown as { description: string }).description).toBe('string');
      }
    }
  });

  // ── connect, and the invariant the story exists for ────────────────────────

  it('connect seals the credential — and NOTHING durable or on the wire carries it', async () => {
    const { tenantId, ownerId, token } = await freshTenant();
    const key = ulid();
    const res = await connect(token, tenantId, delhiveryBody(), key).expect(201);

    const connection = res.body as Record<string, unknown>;
    expect(connection).toMatchObject({
      tenantId,
      carrierCode: 'delhivery',
      carrierName: 'Delhivery',
      accountLabel: 'Delhivery — Mumbai',
      credentialVersion: 1,
      connectedBy: ownerId,
      rotatedAt: null,
      rotatedBy: null,
    });
    expect(connection.credential).toBeUndefined();

    const sql = db();
    try {
      const rows = await sql`select * from carrier_connections where tenant_id = ${tenantId}`;
      expect(rows).toHaveLength(1);
      const row = rows[0] as unknown as { id: string; credential_sealed: string };
      expect(row.id).toBe(connection.id);
      // The column holds an ENVELOPE, and it opens to exactly what was sent.
      expect(row.credential_sealed.startsWith('v1:')).toBe(true);
      expect(openCredential(row.credential_sealed)).toEqual(DELHIVERY_CREDENTIAL);

      const outbox = await sql`select * from outbox_messages where tenant_id = ${tenantId}`;
      const audit = await sql`select * from audit_events where tenant_id = ${tenantId}`;
      const keys = await sql`select * from idempotency_keys where tenant_id = ${tenantId}`;

      expect(outbox.map((message) => (message as unknown as { type: string }).type)).toContain(
        'carrier.connected',
      );
      expect(audit.map((event) => (event as unknown as { action: string }).action)).toContain(
        'carrier.connected',
      );

      // The assertion the acceptance criterion asks for, made DIRECTLY rather
      // than by inspection: neither the plaintext NOR the sealed blob appears
      // in any of the durable records or in the response.
      const secrets = [
        DELHIVERY_CREDENTIAL.apiToken,
        DELHIVERY_CREDENTIAL.clientName,
        row.credential_sealed,
      ];
      const surfaces: [string, string][] = [
        ['the connect response', JSON.stringify(connection)],
        ['the outbox payload', JSON.stringify(outbox)],
        ['the audit row', JSON.stringify(audit)],
        ['the idempotency snapshot', JSON.stringify(keys)],
      ];
      for (const [what, serialized] of surfaces) {
        for (const secret of secrets) {
          expect([what, serialized.includes(secret)]).toEqual([what, false]);
        }
      }

      // Specifically: the payload hash is NOT a hash of the raw secret — it is
      // a master-key HMAC, so the persisted digest is worthless without the
      // key (and reuse detection still works; see the 422 arm below).
      // Registration wrote a key of its own for this tenant — take THIS
      // command's row by its key, not the first row in the table.
      const carrierKeyRows = await sql`
        select payload_hash, response_snapshot from idempotency_keys
        where tenant_id = ${tenantId} and key = ${key}
      `;
      expect(carrierKeyRows).toHaveLength(1);
      const stored = carrierKeyRows[0] as unknown as {
        payload_hash: string;
        response_snapshot: unknown;
      };
      expect(stored.payload_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(stored.response_snapshot)).toContain(connection.id as string);
    } finally {
      await sql.end();
    }

    // The list read carries the public face only.
    const listed = await listConnections(token, tenantId).expect(200);
    expect(listed.body.items).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(DELHIVERY_CREDENTIAL.apiToken);
    expect(listed.body.items[0].credentialSealed).toBeUndefined();
    expect(listed.body.nextCursor).toBeNull();

    // And the replay re-serves the stored snapshot without writing again.
    const replayed = await connect(token, tenantId, delhiveryBody(), key).expect(201);
    expect(replayed.body).toEqual(connection);
    const sql2 = db();
    try {
      const again = await sql2`select count(*)::int as n from carrier_connections where tenant_id = ${tenantId}`;
      expect(Number((again[0] as unknown as { n: number }).n)).toBe(1);
    } finally {
      await sql2.end();
    }
  });

  it('connect refuses an unknown carrier, a missing field and an undeclared field — naming the offender, echoing no value', async () => {
    const { tenantId, token } = await freshTenant();

    const unknown = await connect(token, tenantId, {
      carrierCode: 'shiprocket',
      accountLabel: 'Aggregator',
      credential: { apiToken: DELHIVERY_CREDENTIAL.apiToken },
    }).expect(400);
    expect(unknown.body).toMatchObject({ code: 'validation-failed' });
    expect(unknown.body.detail).toContain('shiprocket');
    // The refusal lists what IS known, so the caller can correct itself.
    expect(unknown.body.detail).toContain('delhivery');
    expect(JSON.stringify(unknown.body)).not.toContain(DELHIVERY_CREDENTIAL.apiToken);

    const missing = await connect(token, tenantId, {
      carrierCode: 'delhivery',
      accountLabel: 'Delhivery — Mumbai',
      credential: { apiToken: DELHIVERY_CREDENTIAL.apiToken },
    }).expect(400);
    expect(missing.body).toMatchObject({ code: 'validation-failed' });
    expect(missing.body.detail).toContain('clientName');
    expect(JSON.stringify(missing.body)).not.toContain(DELHIVERY_CREDENTIAL.apiToken);

    // A blank (whitespace-only) required field is an absent one.
    const blank = await connect(token, tenantId, {
      carrierCode: 'delhivery',
      accountLabel: 'Delhivery — Mumbai',
      credential: { ...DELHIVERY_CREDENTIAL, clientName: '   ' },
    }).expect(400);
    expect(blank.body.detail).toContain('clientName');

    // A field this carrier does not declare would seal material nothing could
    // ever use — refused, naming the field.
    const undeclared = await connect(token, tenantId, {
      carrierCode: 'delhivery',
      accountLabel: 'Delhivery — Mumbai',
      credential: { ...DELHIVERY_CREDENTIAL, licenceKey: 'canary-wrong-carrier-field' },
    }).expect(400);
    expect(undeclared.body.detail).toContain('licenceKey');

    // `credential` must be an OBJECT of fields — a bare string would reach
    // `seal()` as something no adapter could ever read back.
    const notAnObject = await connect(token, tenantId, {
      carrierCode: 'delhivery',
      accountLabel: 'Delhivery — Mumbai',
      credential: 'canary-delhivery-token-f3a91c',
    }).expect(400);
    expect(notAnObject.body).toMatchObject({ code: 'validation-failed' });
    expect(JSON.stringify(notAnObject.body)).not.toContain(DELHIVERY_CREDENTIAL.apiToken);

    // …and every value in it must be a string (a number would serialize into
    // the sealed JSON as something the adapter contract does not allow).
    const nonString = await connect(token, tenantId, {
      carrierCode: 'delhivery',
      accountLabel: 'Delhivery — Mumbai',
      credential: { ...DELHIVERY_CREDENTIAL, apiToken: 123 },
    }).expect(400);
    expect(nonString.body.detail).toContain('apiToken');

    // Values are bounded: without a ceiling a `carrier.manage` holder could
    // seal megabytes into a row every list query carries.
    const huge = 'x'.repeat(513);
    const tooLong = await connect(token, tenantId, {
      carrierCode: 'delhivery',
      accountLabel: 'Delhivery — Mumbai',
      credential: { ...DELHIVERY_CREDENTIAL, apiToken: huge },
    }).expect(400);
    expect(tooLong.body.detail).toContain('apiToken');
    // Naming the field, never echoing it.
    expect(JSON.stringify(tooLong.body)).not.toContain(huge);

    // The account label: `@Length(1, 100)` counts characters, so a blank one
    // clears the DTO and must be caught in the command — otherwise it reaches
    // the DB CHECK and renders as a 500.
    const blankLabel = await connect(token, tenantId, {
      carrierCode: 'delhivery',
      accountLabel: '   ',
      credential: { ...DELHIVERY_CREDENTIAL },
    }).expect(400);
    expect(blankLabel.body).toMatchObject({ code: 'validation-failed' });
    expect(blankLabel.body.title).toContain('accountLabel');

    const longLabel = await connect(token, tenantId, {
      carrierCode: 'delhivery',
      accountLabel: 'L'.repeat(101),
      credential: { ...DELHIVERY_CREDENTIAL },
    }).expect(400);
    expect(longLabel.body).toMatchObject({ code: 'validation-failed' });

    const sql = db();
    try {
      const rows = await sql`select count(*)::int as n from carrier_connections where tenant_id = ${tenantId}`;
      expect(Number((rows[0] as unknown as { n: number }).n)).toBe(0);
    } finally {
      await sql.end();
    }
  });

  it('a second connect for the same carrier is a 409 directing the caller to rotate', async () => {
    const { tenantId, token } = await freshTenant();
    await connect(token, tenantId, delhiveryBody()).expect(201);

    const second = await connect(token, tenantId, delhiveryBody('Delhivery — Delhi')).expect(409);
    expect(second.body).toMatchObject({ code: 'carrier-already-connected' });
    expect(second.body.detail).toContain('rotate');

    // A DIFFERENT carrier is fine — the constraint is per (tenant, carrier).
    await connect(token, tenantId, {
      carrierCode: 'ecom_express',
      accountLabel: 'Ecom Express — Pune',
      credential: { username: 'canary-ecom-user', password: 'canary-ecom-pass' },
    }).expect(201);

    const sql = db();
    try {
      const rows = await sql`select carrier_code from carrier_connections where tenant_id = ${tenantId} order by carrier_code`;
      expect(rows.map((row) => (row as unknown as { carrier_code: string }).carrier_code)).toEqual([
        'delhivery',
        'ecom_express',
      ]);
    } finally {
      await sql.end();
    }
  });

  // ── rotate ─────────────────────────────────────────────────────────────────

  it('rotate replaces the material in place: same id, version + 1, the old material is gone', async () => {
    const { tenantId, ownerId, token } = await freshTenant();
    const created = await connect(token, tenantId, delhiveryBody()).expect(201);
    const connectionId = created.body.id as string;

    const rotated = await rotate(token, tenantId, connectionId, DELHIVERY_ROTATED).expect(200);
    expect(rotated.body.id).toBe(connectionId); // the stable handle AD-15 means
    expect(rotated.body.credentialVersion).toBe(2);
    expect(rotated.body.rotatedBy).toBe(ownerId);
    expect(typeof rotated.body.rotatedAt).toBe('string');
    expect(rotated.body.credential).toBeUndefined();

    const sql = db();
    try {
      const rows = await sql`select * from carrier_connections where id = ${connectionId}::uuid`;
      const row = rows[0] as unknown as { credential_sealed: string; credential_version: number };
      expect(row.credential_version).toBe(2);
      // Opening the stored blob yields the NEW material and not the old.
      expect(openCredential(row.credential_sealed)).toEqual(DELHIVERY_ROTATED);
      expect(row.credential_sealed).not.toContain(DELHIVERY_CREDENTIAL.apiToken);

      // Nothing the rotation wrote carries either generation of the secret.
      const outbox = await sql`select * from outbox_messages where tenant_id = ${tenantId}`;
      const keys = await sql`select * from idempotency_keys where tenant_id = ${tenantId}`;
      const audit = await sql`select * from audit_events where tenant_id = ${tenantId}`;
      for (const serialized of [outbox, keys, audit].map((rowset) => JSON.stringify(rowset))) {
        expect(serialized).not.toContain(DELHIVERY_CREDENTIAL.apiToken);
        expect(serialized).not.toContain(DELHIVERY_ROTATED.apiToken);
        expect(serialized).not.toContain(row.credential_sealed);
      }
      expect(audit.map((event) => (event as unknown as { action: string }).action)).toContain(
        'carrier.credential_rotated',
      );
    } finally {
      await sql.end();
    }

    // Rotation validates against the ROW's carrier, so a field that carrier
    // does not declare is refused and the stored material is untouched.
    const wrongShape = await rotate(token, tenantId, connectionId, {
      licenceKey: 'canary-wrong-carrier-field',
    }).expect(400);
    expect(wrongShape.body.detail).toContain('licenceKey');

    const unknownId = await rotate(token, tenantId, uuidv7(), DELHIVERY_ROTATED).expect(404);
    expect(unknownId.body).toMatchObject({ code: 'not-found' });

    const malformed = await rotate(token, tenantId, 'not-a-uuid', DELHIVERY_ROTATED).expect(400);
    expect(malformed.body).toMatchObject({ code: 'validation-failed' });
  });

  // ── disconnect ─────────────────────────────────────────────────────────────

  it('disconnect deletes the row and the audit trail survives; a repeat under a new key is 404', async () => {
    const { tenantId, token } = await freshTenant();
    const created = await connect(token, tenantId, delhiveryBody()).expect(201);
    const connectionId = created.body.id as string;

    const gone = await disconnect(token, tenantId, connectionId).expect(200);
    expect(gone.body.id).toBe(connectionId);

    const sql = db();
    try {
      // AD-15: disconnect DELETES — no sealed material is left at rest.
      const rows = await sql`select count(*)::int as n from carrier_connections where id = ${connectionId}::uuid`;
      expect(Number((rows[0] as unknown as { n: number }).n)).toBe(0);

      const audit = await sql`
        select action, target_id from audit_events
        where tenant_id = ${tenantId} and action = 'carrier.disconnected'
      `;
      expect(audit).toHaveLength(1);
      expect((audit[0] as unknown as { target_id: string }).target_id).toBe(connectionId);
    } finally {
      await sql.end();
    }

    const repeat = await disconnect(token, tenantId, connectionId).expect(404);
    expect(repeat.body).toMatchObject({ code: 'not-found' });

    // The carrier is free again — connect (not rotate) is the way back.
    await connect(token, tenantId, delhiveryBody('Delhivery — reconnected')).expect(201);
  });

  // ── idempotency ────────────────────────────────────────────────────────────

  it('the same key with DIFFERENT credential material is a 422, and the disconnect replay re-serves its snapshot', async () => {
    const { tenantId, token } = await freshTenant();
    const key = ulid();
    await connect(token, tenantId, delhiveryBody(), key).expect(201);

    // The credential participates in the payload hash (as an HMAC), so a
    // second connect under the SAME key with DIFFERENT material cannot be
    // mistaken for a replay.
    const reused = await connect(
      token,
      tenantId,
      { carrierCode: 'delhivery', accountLabel: 'Delhivery — Mumbai', credential: DELHIVERY_ROTATED },
      key,
    ).expect(422);
    expect(reused.body).toMatchObject({ code: 'idempotency-key-reuse' });

    const created = await listConnections(token, tenantId).expect(200);
    const connectionId = created.body.items[0].id as string;

    const disconnectKey = ulid();
    const first = await disconnect(token, tenantId, connectionId, disconnectKey).expect(200);
    // The row is gone, but the SAME key replays the snapshot rather than 404ing.
    const replay = await disconnect(token, tenantId, connectionId, disconnectKey).expect(200);
    expect(replay.body).toEqual(first.body);
  });

  // ── authority ──────────────────────────────────────────────────────────────

  it('carrier.manage is Owner + Ops Manager only, and a foreign tenant sees nothing', async () => {
    const { tenantId, token } = await freshTenant();
    const opsManager = await createMember(token, tenantId, 'ops_manager');
    const operator = await createMember(token, tenantId, 'operator');
    const accountant = await createMember(token, tenantId, 'accountant');

    // An Ops Manager configures carriers — this is a settings capability.
    const connected = await connect(opsManager.token, tenantId, delhiveryBody()).expect(201);
    const connectionId = connected.body.id as string;

    for (const member of [operator, accountant]) {
      const denied = await connect(member.token, tenantId, {
        carrierCode: 'ecom_express',
        accountLabel: 'Ecom Express — Pune',
        credential: { username: 'canary-ecom-user', password: 'canary-ecom-pass' },
      }).expect(403);
      expect(denied.body).toMatchObject({ code: 'role-denied' });
      expect(denied.body.detail).toContain('carrier.manage');

      await rotate(member.token, tenantId, connectionId, DELHIVERY_ROTATED).expect(403);
      await disconnect(member.token, tenantId, connectionId).expect(403);
    }

    // **Authority precedes validation.** A body this role could never have
    // submitted anyway — an unknown carrier code — must still answer 403, not
    // the 400 that would disclose which codes the registry holds. Without
    // this arm the ordering in `connect` could silently revert.
    const disclosing = await connect(operator.token, tenantId, {
      carrierCode: 'shiprocket',
      accountLabel: 'Aggregator',
      credential: {},
    }).expect(403);
    expect(disclosing.body).toMatchObject({ code: 'role-denied' });
    expect(JSON.stringify(disclosing.body)).not.toContain('delhivery');

    // Reads stay open to any member (the repo never gates a read) — and they
    // still carry no secret.
    const listed = await listConnections(accountant.token, tenantId).expect(200);
    expect(listed.body.items).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(DELHIVERY_CREDENTIAL.apiToken);

    // Another tenant's session on this path is 403; its own path cannot see
    // this connection at all (404, not 403 — the id simply does not exist
    // there).
    // No session at all is the documented 401 on every route here.
    const anonymous = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/carriers`)
      .expect(401);
    expect(anonymous.body).toMatchObject({ code: 'unauthenticated' });

    const other = await freshTenant();
    const foreign = await listConnections(other.token, tenantId).expect(403);
    expect(foreign.body).toMatchObject({ code: 'permission-denied' });
    await rotate(other.token, other.tenantId, connectionId, DELHIVERY_ROTATED).expect(404);
    await disconnect(other.token, other.tenantId, connectionId).expect(404);

    const sql = db();
    try {
      const rows = await sql`select credential_version from carrier_connections where id = ${connectionId}::uuid`;
      expect((rows[0] as unknown as { credential_version: number }).credential_version).toBe(1);
    } finally {
      await sql.end();
    }
  });

  // ── the master key ─────────────────────────────────────────────────────────

  it('with CARRIER_ENCRYPTION_KEY unset CONNECT and ROTATE answer 503 and write nothing — disconnect is exempt', async () => {
    const { tenantId, token } = await freshTenant();
    const created = await connect(token, tenantId, delhiveryBody()).expect(201);
    const connectionId = created.body.id as string;

    const saved = process.env.CARRIER_ENCRYPTION_KEY;
    delete process.env.CARRIER_ENCRYPTION_KEY;
    try {
      // The two commands that must SEAL something cannot proceed.
      const connectRes = await connect(token, tenantId, {
        carrierCode: 'ecom_express',
        accountLabel: 'Ecom Express — Pune',
        credential: { username: 'canary-ecom-user', password: 'canary-ecom-pass' },
      }).expect(503);
      expect(connectRes.body).toMatchObject({ code: 'carrier-encryption-unavailable' });

      const rotateRes = await rotate(token, tenantId, connectionId, DELHIVERY_ROTATED).expect(503);
      expect(rotateRes.body).toMatchObject({ code: 'carrier-encryption-unavailable' });

      const sql = db();
      try {
        const rows = await sql`select carrier_code, credential_version from carrier_connections where tenant_id = ${tenantId}`;
        expect(rows).toHaveLength(1);
        expect((rows[0] as unknown as { credential_version: number }).credential_version).toBe(1);
      } finally {
        await sql.end();
      }

      // A too-short key is the same fault as no key at all.
      process.env.CARRIER_ENCRYPTION_KEY = 'too-short';
      await rotate(token, tenantId, connectionId, DELHIVERY_ROTATED).expect(503);
      delete process.env.CARRIER_ENCRYPTION_KEY;

      // **Disconnect is deliberately key-free** (human decision): it seals
      // nothing, and a lost or rotated-away master key must never strand a
      // tenant with credential rows that nothing can remove — the one case
      // where being unable to read the secret is precisely the reason to
      // delete it. Pinned here so the exemption stays a decision rather than
      // an accident of where the key happens to be touched.
      const removed = await disconnect(token, tenantId, connectionId).expect(200);
      expect(removed.body.id).toBe(connectionId);

      const after = db();
      try {
        const rows = await after`select count(*)::int as n from carrier_connections where tenant_id = ${tenantId}`;
        expect(Number((rows[0] as unknown as { n: number }).n)).toBe(0);
      } finally {
        await after.end();
      }
    } finally {
      process.env.CARRIER_ENCRYPTION_KEY = saved;
    }
  });

  // ── reads ──────────────────────────────────────────────────────────────────

  it('the connection list paginates by keyset and refuses a malformed cursor', async () => {
    const { tenantId, token } = await freshTenant();
    await connect(token, tenantId, delhiveryBody()).expect(201);
    await connect(token, tenantId, {
      carrierCode: 'blue_dart',
      accountLabel: 'Blue Dart — Chennai',
      credential: { licenceKey: 'canary-bd-licence', loginId: 'canary-bd-login' },
    }).expect(201);
    await connect(token, tenantId, {
      carrierCode: 'ecom_express',
      accountLabel: 'Ecom Express — Pune',
      credential: { username: 'canary-ecom-user', password: 'canary-ecom-pass' },
    }).expect(201);

    const first = await listConnections(token, tenantId, '?limit=2').expect(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).not.toBeNull();

    const second = await listConnections(
      token,
      tenantId,
      `?limit=2&cursor=${encodeURIComponent(first.body.nextCursor as string)}`,
    ).expect(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();

    const seen = [...first.body.items, ...second.body.items].map(
      (item: { carrierCode: string }) => item.carrierCode,
    );
    expect([...seen].sort()).toEqual(['blue_dart', 'delhivery', 'ecom_express']);

    const bad = await listConnections(token, tenantId, '?cursor=not-a-cursor').expect(400);
    expect(bad.body).toMatchObject({ code: 'invalid-cursor' });

    const crafted = Buffer.from(
      JSON.stringify({ createdAt: '2026-09-16T00:00:00.000Z', id: 'not-a-uuid' }),
      'utf8',
    ).toString('base64url');
    const craftedRes = await listConnections(token, tenantId, `?cursor=${crafted}`).expect(400);
    expect(craftedRes.body).toMatchObject({ code: 'invalid-cursor' });

    await listConnections(token, tenantId, '?limit=0').expect(400);
  });

  // ── persistence guards ─────────────────────────────────────────────────────

  it('0025 CHECK constraints: a non-envelope blob, a non-positive version, a blank label and a half-stamped rotation are rejected (23514)', async () => {
    // Nothing in the application layer attempts any of these, so without this
    // probe the four hand-appended `ADD CONSTRAINT` lines in the migration
    // could be deleted and the whole suite would still pass. The CHECKs are
    // the DB-side backstop to the command's own refusals — most of all the
    // envelope one, which is what makes "plaintext in this column" a failed
    // write rather than a quietly kept secret.
    const { tenantId, ownerId } = await freshTenant();
    const sql = db();
    try {
      const row = (overrides: Record<string, unknown>): Record<string, unknown> => ({
        id: uuidv7(),
        tenant_id: tenantId,
        carrier_code: 'delhivery',
        account_label: 'Delhivery — Mumbai',
        credential_sealed: 'v1:aXY=:dGFn:Y3Q=',
        credential_version: 1,
        connected_by: ownerId,
        rotated_at: null,
        rotated_by: null,
        ...overrides,
      });
      const insert = (overrides: Record<string, unknown>) => {
        const values = row(overrides);
        return sql.unsafe(
          `insert into carrier_connections
             (id, tenant_id, carrier_code, account_label, credential_sealed,
              credential_version, connected_by, rotated_at, rotated_by)
           values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8::timestamptz, $9::uuid)`,
          Object.values(values) as never[],
        );
      };

      // …_credential_sealed_envelope: raw material can never be stored.
      await expect(
        insert({ credential_sealed: 'canary-delhivery-token-f3a91c' }),
      ).rejects.toMatchObject({ code: '23514' });
      // …_credential_version_positive: the generation counter starts at 1.
      await expect(insert({ credential_version: 0 })).rejects.toMatchObject({ code: '23514' });
      // …_account_label_nonblank: whitespace is not a label.
      await expect(insert({ account_label: '   ' })).rejects.toMatchObject({ code: '23514' });
      // …_rotation_stamp_paired: WHEN and BY WHOM are stamped together.
      await expect(
        insert({ rotated_at: new Date().toISOString(), rotated_by: null }),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(insert({ rotated_at: null, rotated_by: ownerId })).rejects.toMatchObject({
        code: '23514',
      });

      // Meaningfulness: the same statement with nothing violated inserts
      // cleanly, so each rejection above is the CHECK and not a typo.
      await insert({});
      const stored = await sql`select count(*)::int as n from carrier_connections where tenant_id = ${tenantId}`;
      expect(Number((stored[0] as unknown as { n: number }).n)).toBe(1);
    } finally {
      await sql.end();
    }
  });

  // ── tenant isolation ───────────────────────────────────────────────────────

  it('RLS fails closed on carrier_connections: unscoped and foreign-scoped reads see zero rows', async () => {
    const tenantA = await freshTenant();
    const tenantB = await freshTenant();
    await connect(tenantA.token, tenantA.tenantId, delhiveryBody()).expect(201);

    const url = new URL(process.env.DATABASE_URL!);
    url.username = 'wms_rls_probe';
    url.password = 'wms_rls_probe';
    const rls = postgres(url.toString(), { max: 1 });
    const admin = db();
    try {
      // The row exists through the privileged connection…
      const seeded = await admin`select count(*)::int as n from carrier_connections where tenant_id = ${tenantA.tenantId}`;
      expect(Number((seeded[0] as unknown as { n: number }).n)).toBe(1);

      // …and is invisible unscoped (the NULLIF empty-string guard),…
      const unscoped = await rls`select id from carrier_connections where tenant_id = ${tenantA.tenantId}`;
      expect(unscoped).toHaveLength(0);

      // …and invisible when scoped to another tenant.
      const foreign = await rls.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantB.tenantId}, true)`;
        return tx`select id from carrier_connections where tenant_id = ${tenantA.tenantId}`;
      });
      expect(foreign).toHaveLength(0);

      // The own-tenant arm is visible (the policy is not simply "deny all").
      const own = await rls.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantA.tenantId}, true)`;
        return tx`select id from carrier_connections where tenant_id = ${tenantA.tenantId}`;
      });
      expect(own).toHaveLength(1);

      // The write side fails closed too (the WITH CHECK arm).
      await expect(
        rls.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${tenantB.tenantId}, true)`;
          return tx.unsafe(
            `insert into carrier_connections (id, tenant_id, carrier_code, account_label, credential_sealed, connected_by)
             values ('${uuidv7()}'::uuid, '${tenantA.tenantId}'::uuid, 'delhivery', 'smuggled', 'v1:a:b:c', '${uuidv7()}'::uuid)`,
          );
        }),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await rls.end();
      await admin.end();
    }
  });

  it('the connect replay is scoped to its OWN tenant — a foreign key-holder cannot hijack a connection', async () => {
    // The twin of the 3.2 device-credential case. `idempotency_keys` is unique
    // per (tenant_id, key), not per key, so a replay lookup on `key` alone
    // would read another tenant's row — handing back their connection on a
    // payload-hash match, or 422-ing on a key this tenant never used.
    const { tenantId, token } = await freshTenant();
    const sharedKey = ulid();

    const seeder = db();
    try {
      await seeder`
        insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot)
        values (
          ${uuidv7()}, ${uuidv7()}, ${sharedKey}, ${'b'.repeat(64)},
          ${seeder.json({ connection: { id: uuidv7(), tenantId: uuidv7(), carrierCode: 'delhivery', accountLabel: 'someone elses account' } })}
        )
      `;
    } finally {
      await seeder.end();
    }

    const connected = await connect(token, tenantId, delhiveryBody(), sharedKey).expect(201);
    expect(connected.body.tenantId).toBe(tenantId);
    expect(connected.body.accountLabel).toBe('Delhivery — Mumbai');
  });

  // ── contract ───────────────────────────────────────────────────────────────

  it('the OpenAPI document exposes the carriers contract (drift guard companion)', () => {
    const committed = JSON.parse(
      readFileSync(resolve(process.cwd(), 'openapi/openapi.json'), 'utf8') as string,
    ) as { paths: Record<string, unknown> };
    expect(Object.keys(committed.paths)).toEqual(
      expect.arrayContaining([
        '/tenants/{tenantId}/carriers',
        '/tenants/{tenantId}/carriers/connections',
        '/tenants/{tenantId}/carriers/connections/{connectionId}/rotate',
        '/tenants/{tenantId}/carriers/connections/{connectionId}/disconnect',
      ]),
    );
    // No response schema in the document may carry credential material — the
    // contract is what clients generate from, so a leak here would be a leak
    // in every client at once.
    const serialized = JSON.stringify(committed);
    expect(serialized).not.toContain('credentialSealed');
  });
});
