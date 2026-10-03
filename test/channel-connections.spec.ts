import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { openCredential } from '../src/modules/channels/channel-credentials';
import { sealCredential } from '../src/modules/channels/channel-credentials';
import { registerChannelAdapter } from '../src/modules/channels/channel-registry';
import { testAvailabilityArm } from '../src/modules/channels/channel-availability-port';
import { testWritebackArm } from '../src/modules/channels/channel-writeback-port';
import { testAddress } from './support/shipment-address';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

// The e2e suite talks to the real Postgres and signs sessions; the vault
// needs a real master key (any ≥32-char string — the sha256 normalizes it).
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.CHANNEL_ENCRYPTION_KEY ??= 'e2e-only-channel-encryption-key-0123456789abcdef';
// A host that exports any poll interval would boot the background workers
// and race these tests — the sibling suites' convention, extended to the
// channels sync worker.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.CHANNELS_SYNC_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

/**
 * The fixture credentials (the carriers canary convention): every string is
 * deliberately distinctive, and the suite greps the stored blob, the outbox
 * payloads, the audit rows, the idempotency snapshots and every response
 * body for them — the vault's "secret material leaves the system exactly
 * never" invariant, made falsifiable.
 */
const SHOPIFY_CREDENTIAL = {
  shopDomain: 'canary-channel-store.myshopify.com',
  accessToken: 'canary-shopify-token-4d1ba2',
};
const SHOPIFY_ROTATED = {
  shopDomain: 'canary-channel-store.myshopify.com',
  accessToken: 'canary-shopify-rotated-7c22e9',
};

/**
 * The revoke RECORDER (epic-7 retro D4): the disconnect's post-commit revoke
 * attempt opens the credential IN PROCESS — this arm captures that content,
 * making WHICH blob the revoke received falsifiable. In-capture only
 * (in-process, never logged/persisted); the canary strings stay here.
 */
const revokeReceived: Record<string, unknown>[] = [];
registerChannelAdapter({
  code: 'test-revoke',
  displayName: 'Test Revoke',
  credentialFields: [{ name: 'apiKey', label: 'API key', required: true, description: 'test key' }],
  availabilityArm: testAvailabilityArm(),
  revokeArm: async (args) => {
    revokeReceived.push(args.credential as Record<string, unknown>);
    return { status: 'revoked' };
  },
  orderWritebackArm: testWritebackArm(new Map()),
});

describe('channel connections, credentials and config (e2e, story 7-1)', () => {
  let app: INestApplication;
  const createdTenantIds: string[] = [];
  let suiteDb: SuiteDatabase;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('channel_connections');
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
        'integrations',
        'channel_mappings',
        'integration_calls',
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

  function sqlHandle(): postgres.Sql<Record<string, unknown>> {
    return postgres(process.env.DATABASE_URL!, { max: 1 });
  }

  /**
   * Widens the integrations provider CHECK on THIS suite's throwaway DB
   * clone so the registered test-revoke adapter can hold an integrations row
   * (the sync suite's admitTestProviderInDb pattern — runtime-only, the
   * prod CHECK keeps the frozen three).
   */
  async function admitTestProviderInDb(): Promise<void> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await sql`alter table integrations drop constraint if exists integrations_provider_check`;
      await sql`alter table integrations add constraint integrations_provider_check check (provider in ('shopify', 'amazon-in', 'flipkart', 'test-revoke'))`;
    } finally {
      await sql.end();
    }
  }

  async function signIn(email: string, password = 'correct-horse-battery'): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`${API}/sign-in`)
      .send({ email, password })
      .expect(200);
    return res.body.accessToken as string;
  }

  async function freshTenant(): Promise<{ tenantId: string; ownerId: string; token: string }> {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const res = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({
        name: `Channel Co ${email.split('@')[0]}`,
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
      .post(`${API}/${tenantId}/channels/connections`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function rotate(
    token: string,
    tenantId: string,
    connectionId: string,
    credentials: unknown,
    key = ulid(),
  ): request.Test {
    return request(app.getHttpServer())
      .put(`${API}/${tenantId}/channels/connections/${connectionId}/credentials`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ credentials });
  }

  function setConfig(
    token: string,
    tenantId: string,
    connectionId: string,
    body: Record<string, unknown>,
    key = ulid(),
  ): request.Test {
    return request(app.getHttpServer())
      .put(`${API}/${tenantId}/channels/connections/${connectionId}`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function disconnect(
    token: string,
    tenantId: string,
    connectionId: string,
    key = ulid(),
  ): request.Test {
    return request(app.getHttpServer())
      .delete(`${API}/${tenantId}/channels/connections/${connectionId}`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({});
  }

  function listConnections(token: string, tenantId: string): request.Test {
    return request(app.getHttpServer())
      .get(`${API}/${tenantId}/channels/connections`)
      .set('Authorization', `Bearer ${token}`);
  }

  function retryPost(token: string, tenantId: string, connectionId: string, key = ulid()): request.Test {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/channels/connections/${connectionId}/retry`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({});
  }

  function putBuffers(
    token: string,
    tenantId: string,
    connectionId: string,
    items: unknown,
  ): request.Test {
    return request(app.getHttpServer())
      .put(`${API}/${tenantId}/channels/connections/${connectionId}/buffers`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, ulid())
      .send({ items });
  }

  const shopifyBody = (): Record<string, unknown> => ({
    provider: 'shopify',
    credentials: { ...SHOPIFY_CREDENTIAL },
  });

  // ── arm 1: connect ─────────────────────────────────────────────────────────

  it('connect: 201, the public face, the blob sealed and round-trippable, no material in any durable record', async () => {
    const { tenantId, ownerId, token } = await freshTenant();
    const key = ulid();
    const res = await connect(token, tenantId, shopifyBody(), key).expect(201);
    const connection = res.body as Record<string, unknown>;
    expect(connection).toMatchObject({
      tenantId,
      provider: 'shopify',
      providerName: 'Shopify',
      status: 'connected',
      credentialVersion: 1,
      backorderPolicy: 'accept',
      connectedBy: ownerId,
      breakerState: 'closed',
      rotatedAt: null,
      rotatedBy: null,
      lastSyncedAt: null,
      lastAttemptAt: null,
      lastError: null,
    });
    expect(typeof connection.id).toBe('string');
    expect(connection.credential).toBeUndefined();

    const sql = sqlHandle();
    try {
      const rows = (await sql`
        select credential_sealed, credential_version, connected_by, status, breaker_state
        from integrations where tenant_id = ${tenantId}
      `) as unknown as { credential_sealed: string; credential_version: number; connected_by: string; status: string; breaker_state: string }[];
      const row = rows[0]!;
      expect(row.status).toBe('connected');
      expect(row.breaker_state).toBe('closed');
      expect(row.credential_version).toBe(1);
      // The stored blob is an envelope — plaintext and rotatable material
      // appear NOWHERE, and the blob round-trips under the master key into
      // exactly the material (the vault's open path, verified directly).
      const opened = openCredential(row.credential_sealed) as Record<string, string>;
      expect(opened).toEqual(SHOPIFY_CREDENTIAL);

      const audits = (await sql`
        select actor_user_id, action, target_type, target_id from audit_events
        where tenant_id = ${tenantId} and action = 'channels.connected'
      `) as unknown as { actor_user_id: string; action: string; target_type: string; target_id: string }[];
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: 'channels.connected', target_type: 'channel_connection' });

      const outbox = (await sql`
        select payload from outbox_messages where tenant_id = ${tenantId} and type = 'channels.connected'
      `) as unknown as { payload: unknown }[];
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.payload).toMatchObject({ connectionId: connection.id, provider: 'shopify', credentialVersion: 1 });

      // The tenant's registration consumed a key of its own — take THIS
      // command's row by its key (the carriers suite's rule).
      const idem = (await sql`
        select response_snapshot from idempotency_keys where tenant_id = ${tenantId} and key = ${key}
      `) as unknown as { response_snapshot: unknown }[];
      expect(idem).toHaveLength(1);
      expect((idem[0]!.response_snapshot as Record<string, unknown>).connection)
        .toMatchObject({ id: connection.id });

      // The full leak scan (the carriers suite's): neither plaintext canary
      // NOR the sealed blob in any response or durable surface.
      const secrets = [SHOPIFY_CREDENTIAL.accessToken, SHOPIFY_CREDENTIAL.shopDomain, row.credential_sealed];
      const surfaces: [string, string][] = [
        ['the connect response', JSON.stringify(connection)],
        ['the outbox payload', JSON.stringify(outbox[0]!.payload)],
        ['the audit row', JSON.stringify(audits)],
        ['the idempotency snapshot', JSON.stringify(idem)],
      ];
      for (const [what, serialized] of surfaces) {
        for (const secret of secrets) {
          expect([what, serialized.includes(secret)]).toEqual([what, false]);
        }
      }
    } finally {
      await sql.end();
    }
  });

  it('connect: an unregistered provider is a 400 naming the known set, and a duplicate is 409 connection-exists', async () => {
    const { tenantId, token } = await freshTenant();
    const bad = await connect(token, tenantId, {
      provider: 'etsy',
      credentials: { apiKey: 'whatever' },
    }).expect(400);
    expect(bad.body).toMatchObject({ code: 'validation-failed' });
    expect((bad.body.detail as string) ?? '').toContain('shopify');

    await connect(token, tenantId, shopifyBody()).expect(201);
    const dup = await connect(token, tenantId, shopifyBody()).expect(409);
    expect(dup.body).toMatchObject({ code: 'connection-exists' });
  });

  it('connect: a missing required credential field is a 400 naming the FIELD (never the value)', async () => {
    const { tenantId, token } = await freshTenant();
    const res = await connect(token, tenantId, {
      provider: 'shopify',
      credentials: { shopDomain: 'only-domain.myshopify.com' },
    }).expect(400);
    expect(res.body).toMatchObject({ code: 'validation-failed', status: 400 });
    expect((res.body.detail as string) ?? '').toContain('accessToken');
  });

  it('connect: an idempotent repeat under the same key replays the same connection; reuse with other material is 422', async () => {
    const { tenantId, token } = await freshTenant();
    const key = ulid();
    const first = await connect(token, tenantId, shopifyBody(), key).expect(201);
    const replay = await connect(token, tenantId, shopifyBody(), key).expect(201);
    expect(replay.body.id).toBe(first.body.id);
    // A replay appends no second publication (the replay returns before any
    // append), and one key row only.
    const sql = sqlHandle();
    try {
      const outbox = (await sql`
        select id from outbox_messages where tenant_id = ${tenantId} and type = 'channels.connected'
      `) as unknown as { id: string }[];
      expect(outbox).toHaveLength(1);
    } finally {
      await sql.end();
    }
    // Same key, DIFFERENT credential material: the payload hash's 422.
    const reused = await connect(
      token,
      tenantId,
      { provider: 'shopify', credentials: { ...SHOPIFY_CREDENTIAL, accessToken: 'canary-other-token-a1b2c3' } },
      key,
    ).expect(422);
    expect(reused.body).toMatchObject({ code: 'idempotency-key-reuse' });
  });

  it('connect: an operator has no channel.manage (403 role-denied); the ops manager does', async () => {
    const { tenantId, ownerId, token } = await freshTenant();
    void ownerId;
    const operator = await createMember(token, tenantId, 'operator');
    const refused = await connect(operator.token, tenantId, shopifyBody()).expect(403);
    expect(refused.body).toMatchObject({ code: 'role-denied' });

    const ops = await createMember(token, tenantId, 'ops_manager');
    // The (tenant, provider) slot is free in this tenant (the operator's
    // connects were refused — nothing landed), so the ops manager's connects.
    const allowed = await connect(ops.token, tenantId, shopifyBody()).expect(201);
    expect(allowed.body.provider).toBe('shopify');
  });

  it('arm 3: disconnect deletes the row, meters the revoke attempt, replays 204, and a new-key repeat is 404', async () => {
    const { tenantId, token } = await freshTenant();
    const created = await connect(token, tenantId, shopifyBody()).expect(201);
    const connectionId = created.body.id as string;
    const key = ulid();
    await disconnect(token, tenantId, connectionId, key).expect(204);
    // Same-key replay: settled (no second revoke attempt, still 204).
    await disconnect(token, tenantId, connectionId, key).expect(204);
    // New key: the row is gone — the 404 (the carriers rule).
    const repeat = await disconnect(token, tenantId, connectionId, ulid()).expect(404);
    expect(repeat.body).toMatchObject({ code: 'not-found' });

    const sql = sqlHandle();
    try {
      const rows = (await sql`
        select id from integrations where tenant_id = ${tenantId}
      `) as unknown as { id: string }[];
      expect(rows).toEqual([]);
      // The revoke attempt was metered (kind credential-revoke) — story 7-2
      // (RD-6) replaced shopify's `unconfiguredRevokeArm` ('ok' honest
      // no-op) with the REAL transport: the attempt here rides post-delete
      // (RN-7), hits no channel and honestly meters the transport failure.
      // The DISCONNECT itself stays non-blocking — 204, row deleted, replay
      // 204, repeat 404 regardless of this arm's outcome.
      const calls = (await sql`
        select kind, status, integration_id, error from integration_calls where tenant_id = ${tenantId}
      `) as unknown as { kind: string; status: string; integration_id: string; error: string | null }[];
      expect(calls).toEqual([
        expect.objectContaining({ kind: 'credential-revoke', status: 'failed', integration_id: connectionId }),
      ]);
      const audits = (await sql`
        select action from audit_events where tenant_id = ${tenantId} and action = 'channels.disconnected'
      `) as unknown as { action: string }[];
      expect(audits).toHaveLength(1);
      // Exactly one disconnect key row; the replay consumed no second row.
      const idem = (await sql`
        select response_snapshot from idempotency_keys where tenant_id = ${tenantId} and key = ${key}
      `) as unknown as { response_snapshot: unknown }[];
      // The disconnect's key row records the disconnect happened (its
      // snapshot carries {disconnected: id} — never credential material).
      expect(JSON.stringify(idem[0]!.response_snapshot)).toContain(connectionId);
    } finally {
      await sql.end();
    }
  });

  it('disconnect revokes the RE-LOCKED row’s sealed blob: a rotate committing BETWEEN the phases revokes the ROTATED credential, never Phase 1’s (epic-7 retro D4)', async () => {
    await admitTestProviderInDb();
    const { tenantId, ownerId, token } = await freshTenant();
    // The test-revoke connection rides a DIRECT sealed insert (the DTO's
    // frozen provider vocabulary keeps the frozen three; the vault machinery
    // is credential-shape-agnostic) — the recorder's revoke arm then makes
    // WHICH blob the disconnect's revoke attempt received falsifiable.
    const V1 = 'canary-revoke-v1-a1a1a1';
    const seed = sqlHandle();
    let connectionId: string;
    try {
      const sealed = sealCredential({ apiKey: V1 });
      const inserted = (await seed`
        insert into integrations
          (id, tenant_id, provider, status, credential_sealed, credential_version,
           backorder_policy, connected_by, created_at, updated_at)
        values (${uuidv7()}, ${tenantId}, 'test-revoke', 'connected', ${sealed}, 1,
                'accept', ${ownerId}, now(), now())
        returning id
      `) as unknown as { id: string }[];
      connectionId = inserted[0]!.id;
    } finally {
      await seed.end();
    }

    // The RACE — D4's window, produced deterministically through the row
    // lock's queue (a sequential rotate-then-disconnect proves nothing:
    // Phase 1 would read the rotated row too). A third transaction holds
    // the integrations row's lock; the disconnect is fired FIRST (it parks
    // in its Phase-1 FOR UPDATE, queued), the rotate queues behind it, and
    // only then does the holder commit. Postgres grants queued waiters in
    // order, so the rotate lands BETWEEN the disconnect's two phases:
    //
    //   disconnect Phase 1 ← reads the V1 blob under its lock, commits
    //   rotate             ← writes the V2 blob, commits   ← the D4 window
    //   disconnect Phase 2 ← re-locks; the V2 row is the one it deletes
    //
    // The revoke must open the blob captured under the PHASE-2 lock (V2);
    // Phase 1's capture (V1) is the stale one D4 forbids revoking. If the
    // interleave ever misfires, the rotate's 200-vs-404 assertion fails
    // loudly — a mistimed race can never pass silently.
    const V2 = 'canary-revoke-v2-b2b2b2';
    revokeReceived.length = 0;

    /** Wait until `min` sessions are PARKED on the integrations row lock —
     * a lock-wait whose query is the `... for update` select, blocked by the
     * holder's own pid, so no other suite's session can pollute the count. */
    const waitRowWaiters = async (holderPid: number, min: number, deadlineMs: number): Promise<void> => {
      const probe = sqlHandle();
      try {
        const deadline = Date.now() + deadlineMs;
        while (Date.now() < deadline) {
          const waiting = (await probe`
            select a.pid, a.wait_event_type as wevent from pg_stat_activity a
            where a.wait_event_type = 'Lock' and a.state = 'active'
              and a.query ilike '%integrations%' and a.query ilike '%for update%'
              and ${holderPid} = any(pg_blocking_pids(a.pid))
          `) as unknown as { pid: number; wevent: string }[];
          if (waiting.length >= min) return;
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error(`only ${min - 1} waiter(s) parked on the row lock; the command never got there`);
      } finally {
        await probe.end();
      }
    };

    // The two HTTP requests are fired INSIDE the holder's transaction (and
    // awaited only after every phase has run) so their ordering on the lock
    // queue is the one the comments above promise.
    const holder = sqlHandle();
    let disconnecting: Promise<unknown> | undefined;
    let rotating: Promise<unknown> | undefined;
    try {
      await holder.begin(async (tx) => {
        const locked = (await tx`
          select pg_backend_pid() as pid from integrations
          where tenant_id = ${tenantId} and id = ${connectionId} for update
        `) as unknown as { pid: number }[];
        disconnecting = (async () => disconnect(token, tenantId, connectionId, ulid()).expect(204))();
        // The disconnect must be ON the lock (not merely in flight) before
        // the rotate fires — otherwise the rotate could win the row first.
        await waitRowWaiters(locked[0]!.pid, 1, 5000);
        rotating = (async () => rotate(token, tenantId, connectionId, { apiKey: V2 }).expect(200))();
        // Normally the rotate parks within ms and this returns immediately.
        // The bail-out just keeps a stalled rotate from eating the test
        // budget — everything is still re-checked loudly below.
        await waitRowWaiters(locked[0]!.pid, 2, 1000).catch(() => undefined);
        // Returning commits — the queue drains in fire order.
      });
    } finally {
      await holder.end();
    }
    const [deleted, rotated] = (await Promise.all([disconnecting!, rotating!])) as [
      { status: number },
      { body: Record<string, unknown> },
    ];
    expect(deleted.status).toBe(204);
    expect(rotated.body).toMatchObject({ id: connectionId, credentialVersion: 2 });

    // The revoke attempt opened the RE-LOCKED row's blob — the ROTATED one.
    expect(revokeReceived).toEqual([{ apiKey: V2 }]);
    expect(JSON.stringify(revokeReceived)).not.toContain(V1);

    // The attempt metered honestly (the recorder's arm worked).
    const meter = sqlHandle();
    try {
      const calls = (await meter`
        select kind, status, integration_id as "integrationId" from integration_calls
        where tenant_id = ${tenantId}
      `) as unknown as { kind: string; status: string; integrationId: string }[];
      expect(calls).toEqual([
        expect.objectContaining({ kind: 'credential-revoke', status: 'ok', integrationId: connectionId }),
      ]);
    } finally {
      await meter.end();
    }
  });

  it('arm 2 + 2b: rotate bumps the version in place (same id), config flips the backorder policy, arm 4 lists the health row', async () => {
    const { tenantId, token } = await freshTenant();
    const created = await connect(token, tenantId, shopifyBody()).expect(201);
    const connectionId = created.body.id as string;

    const rotated = await rotate(token, tenantId, connectionId, SHOPIFY_ROTATED).expect(200);
    expect(rotated.body).toMatchObject({
      id: connectionId,
      credentialVersion: 2,
      rotatedBy: expect.any(String),
    });
    expect(typeof rotated.body.rotatedAt).toBe('string');
    expect(rotated.body.credential).toBeUndefined();

    // The blob is the ROTATED material round-tripped.
    const sql = sqlHandle();
    try {
      const rows = (await sql`
        select credential_sealed from integrations where tenant_id = ${tenantId} and id = ${connectionId}
      `) as unknown as { credential_sealed: string }[];
      expect(openCredential(rows[0]!.credential_sealed) as Record<string, string>).toEqual(SHOPIFY_ROTATED);
    } finally {
      await sql.end();
    }

    const configured = await setConfig(token, tenantId, connectionId, { backorderPolicy: 'reject' }).expect(200);
    expect(configured.body).toMatchObject({ id: connectionId, backorderPolicy: 'reject' });
    await setConfig(token, tenantId, connectionId, { backorderPolicy: 'maybe' }).expect(400);

    const list = await listConnections(token, tenantId).expect(200);
    const entries = list.body.items as Record<string, unknown>[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: connectionId,
      provider: 'shopify',
      status: 'connected',
      backorderPolicy: 'reject',
      credentialVersion: 2,
      // Never synced: the lag is null → degraded (the frozen mapping's
      // honest "no evidence yet" figure), the breaker closed.
      health: 'degraded',
      breakerState: 'closed',
      lastSyncedAt: null,
      syncLagMs: null,
      lastError: null,
      buffers: [],
      mappingCount: 0,
    });
    // The list never carries the plaintext or the sealed blob.
    const text = JSON.stringify(list.body);
    for (const secret of [SHOPIFY_ROTATED.accessToken, ...(await sealedBlobs(tenantId))]) {
      expect([secret, text.includes(secret)]).toEqual([secret, false]);
    }
  });

  it('the 7-2 config arms (review patch P9): the ingest warehouse SET/ECHO/CLEAR and its 404 class', async () => {
    const { tenantId, token } = await freshTenant();
    const created = await connect(token, tenantId, shopifyBody()).expect(201);
    const connectionId = created.body.id as string;
    const warehouse = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, ulid())
      .send({ origin: testAddress(), code: `CHC-${ulid().slice(10, 16).toUpperCase()}`, name: `Channel WH ${ulid()}` })
      .expect(201);
    const warehouseId = warehouse.body.id as string;

    // SET: the snapshot echoes the warehouse (RD-4's WYSIWYG).
    const set = await setConfig(token, tenantId, connectionId, {
      backorderPolicy: 'accept',
      ingestWarehouseId: warehouseId,
    }).expect(200);
    expect(set.body).toMatchObject({ id: connectionId, ingestWarehouseId: warehouseId });
    // ABSENT (only the policy changed here) leaves the warehouse unchanged.
    const untouched = await setConfig(token, tenantId, connectionId, { backorderPolicy: 'reject' }).expect(200);
    expect(untouched.body.ingestWarehouseId).toBe(warehouseId);
    // CLEAR: the explicit null lands in the snapshot as null.
    const cleared = await setConfig(token, tenantId, connectionId, {
      backorderPolicy: 'accept',
      ingestWarehouseId: null,
    }).expect(200);
    expect(cleared.body.ingestWarehouseId).toBeNull();
    // UNKNOWN uuid → 404 naming the warehouse, never a bare not-found.
    const unknown = uuidv7();
    const notFound = await setConfig(token, tenantId, connectionId, {
      backorderPolicy: 'accept',
      ingestWarehouseId: unknown,
    }).expect(404);
    expect(notFound.body.code).toBe('not-found');
    expect(notFound.body.detail).toContain(unknown);
    // A FOREIGN tenant's warehouse → 404 too (the set must be THIS tenant's).
    const other = await freshTenant();
    const foreignWh = (
      await request(app.getHttpServer())
        .post(`${API}/${other.tenantId}/warehouses`)
        .set('Authorization', `Bearer ${other.token}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `CHF-${ulid().slice(10, 16).toUpperCase()}`, name: `Foreign WH ${ulid()}` })
        .expect(201)
    ).body.id as string;
    await setConfig(token, tenantId, connectionId, {
      backorderPolicy: 'accept',
      ingestWarehouseId: foreignWh,
    }).expect(404);
    // The failed writes cleared nothing — the state still reads the clear.
    const list = await listConnections(token, tenantId).expect(200);
    expect(list.body.items[0]).toMatchObject({ id: connectionId, ingestWarehouseId: null });
  });

  async function sealedBlobs(tenantId: string): Promise<string[]> {
    const sql = sqlHandle();
    try {
      const rows = (await sql`
        select credential_sealed from integrations where tenant_id = ${tenantId}
      `) as unknown as { credential_sealed: string | null }[];
      return rows.map((row) => row.credential_sealed ?? '').filter(Boolean);
    } finally {
      await sql.end();
    }
  }

  it('the not-found arms: rotate, config, disconnect and retry on an unknown connection id', async () => {
    const { tenantId, token } = await freshTenant();
    const ghost = uuidv7();
    await rotate(token, tenantId, ghost, SHOPIFY_CREDENTIAL).expect(404);
    await setConfig(token, tenantId, ghost, { backorderPolicy: 'reject' }).expect(404);
    await disconnect(token, tenantId, ghost).expect(404);
    await retryPost(token, tenantId, ghost).expect(404);
  });

  it('retry (arm 6): 200 on a live connection, and the replay under the same key settles without a second publication', async () => {
    const { tenantId, token } = await freshTenant();
    const created = await connect(token, tenantId, shopifyBody()).expect(201);
    const connectionId = created.body.id as string;
    const retried = await retryPost(token, tenantId, connectionId).expect(200);
    expect(retried.body).toMatchObject({ id: connectionId, breakerState: 'closed' });

    const replayKey = ulid();
    const first = await retryPost(token, tenantId, connectionId, replayKey).expect(200);
    const again = await retryPost(token, tenantId, connectionId, replayKey).expect(200);
    expect(again.body.id).toBe(first.body.id);
    // A same-key replay wrote no second sync-retried publication: exactly
    // one per FRESH invocation (the pre-test one + the replayKey's own).
    const sql = sqlHandle();
    try {
      const outbox = (await sql`
        select id from outbox_messages where tenant_id = ${tenantId} and type = 'channels.sync_retried'
      `) as unknown as { id: string }[];
      expect(outbox).toHaveLength(2);
    } finally {
      await sql.end();
    }
  });

  it('the tenant boundary: another tenant’s list is 403, one tenant’s id against another tenant fails 404, a bad uuid is 400', async () => {
    const { tenantId: tenantA, token: tokenA } = await freshTenant();
    const { tenantId: tenantB, token: tokenB } = await freshTenant();
    const created = await connect(tokenA, tenantA, shopifyBody()).expect(201);
    const connectionId = created.body.id as string;
    await request(app.getHttpServer())
      .get(`${API}/${tenantA}/channels/connections`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(403);
    await rotate(tokenB, tenantB, connectionId, SHOPIFY_CREDENTIAL).expect(404);
    await rotate(tokenA, tenantA, 'not-a-uuid', SHOPIFY_CREDENTIAL).expect(400);
  });

  it('arm 5 on the wire (out-of-scope guards): unknown connection 404, unknown warehouse 404, shape out-of-bounds 400', async () => {
    const { tenantId, token } = await freshTenant();
    const created = await connect(token, tenantId, shopifyBody()).expect(201);
    const connectionId = created.body.id as string;
    await putBuffers(token, tenantId, uuidv7(), [
      { warehouseId: uuidv7(), skuId: uuidv7(), bufferMilli: 0 },
    ]).expect(404);
    await putBuffers(token, tenantId, connectionId, [
      { warehouseId: uuidv7(), skuId: uuidv7(), bufferMilli: 0 },
    ]).expect(404);

    const put = (items: unknown): request.Test => putBuffers(token, tenantId, connectionId, items);
    await put([]).expect(400);
    await put([{ warehouseId: uuidv7(), skuId: uuidv7(), bufferMilli: 1.5 }]).expect(400);
    await put([{ warehouseId: uuidv7(), skuId: uuidv7(), bufferMilli: -1 }]).expect(400);
    await put(
      Array.from({ length: 201 }, () => ({ warehouseId: uuidv7(), skuId: uuidv7(), bufferMilli: 0 })),
    ).expect(400);
  });
});