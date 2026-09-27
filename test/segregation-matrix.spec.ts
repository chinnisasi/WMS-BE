import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ulid } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
// The matrix read is data over the predicate — the cross-check imports the
// predicate itself, so the response and the gates cannot diverge silently.
import {
  enumerateIncompatiblePairs,
  HAZARD_CLASSES,
  hazardClassesCompatible,
} from '../src/shared/primitives/hazard';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

// The e2e suite talks to the real Postgres (docker-compose dev DB by default;
// CI provides the service container) and signs sessions — the same bootstrap
// the sibling suites run.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

/**
 * Story 12-7 — `GET /tenants/{t}/catalog/segregation-matrix`, the ungated
 * read that turns the shared predicate (`hazard.ts`) into data for the web's
 * matrix card:
 *
 * | Scenario | Pinned by |
 * |---|---|
 * | 200 with the exact 7-class vocabulary + the exact 11-pair set | `answers the matrix` |
 * | every unordered pair cross-checked against `hazardClassesCompatible` | `agrees with the predicate over all 28 pairs` |
 * | member session (operator) → 200, the read is open to any member | `a member session reads the same matrix` |
 * | foreign session → 403 `permission-denied` | `a foreign session is refused` |
 * | unauthenticated → 401 | `an unauthenticated call is refused` |
 * | OpenAPI path | `the OpenAPI document exposes` |
 */
describe('segregation matrix (e2e, story 12-7)', () => {
  let app: INestApplication;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;

  let suiteDb: SuiteDatabase;

  beforeAll(async () => {
    // infra-1: this suite owns its own database (cloned from the template).
    suiteDb = await useSuiteDatabase('segregation_matrix');
    app = await createApp(false);
    await app.init();

    // ── tenant + owner (the read is open to any member; owner is enough) ──
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Matrix Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = await request(app.getHttpServer())
      .post(`${API}/sign-in`)
      .send({ email, password: 'correct-horse-battery' })
      .expect(200)
      .then((res) => res.body.accessToken as string);
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
    const cleaner = (await import('postgres')).default(process.env.DATABASE_URL!, { max: 1 });
    try {
      await cleaner.unsafe('DELETE FROM outbox_messages WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM tenants WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
    } finally {
      await cleaner.end();
    }
  }

  test('answers the vocabulary and the exact 11-pair incompatible set', async () => {
    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/segregation-matrix`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200)
      .expect('Content-Type', /json/);

    // The vocabulary, in declaration order — the endpoint's only class list.
    expect(res.body.classes).toEqual([...HAZARD_CLASSES]);

    // The FULLY EXPANDED set: the explosive universal rule enumerated as
    // unordered pairs INCLUDING `explosive|explosive` (an explosive
    // segregates from every classed SKU, its own class included), plus the
    // four explicit pairs — 11 today, under the predicate's own sorted-key
    // convention. Asserted as an exact set, not a superset: a silently
    // narrowed or widened list must fail here.
    expect(res.body.incompatible).toEqual(enumerateIncompatiblePairs());
    expect(res.body.incompatible).toHaveLength(11);
    const pairs = new Set(
      (res.body.incompatible as { a: string; b: string }[]).map(({ a, b }) => `${a}|${b}`),
    );
    expect(pairs).toEqual(
      new Set([
        // explosive × every class, self included (7 — the universal rule).
        'corrosive-acid|explosive',
        'corrosive-base|explosive',
        'explosive|explosive',
        'explosive|flammable',
        'explosive|gas',
        'explosive|oxidizer',
        'explosive|toxic',
        // the explicit INCOMPATIBLE_PAIRS (4).
        'corrosive-acid|corrosive-base',
        'corrosive-acid|toxic',
        'flammable|oxidizer',
        'gas|oxidizer',
      ]),
    );
  });

  test('agrees with the predicate over all 28 unordered pairs (the drift pin)', async () => {
    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/segregation-matrix`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const incompatible = new Set(
      (res.body.incompatible as { a: string; b: string }[]).map(({ a, b }) => `${a}|${b}`),
    );

    // For EVERY unordered pair over the vocabulary — self-pairs included —
    // the response must say exactly what `hazardClassesCompatible` says,
    // under the predicate's own sorted-key spelling. The FE renders
    // `compatible(a, b) = !incompatible.includes(pair)` with zero logic of
    // its own; this is the assertion that keeps the two from diverging when
    // the predicate (or the vocabulary) widens in hazard.ts.
    const sortedKey = (x: string, y: string): string => (x < y ? `${x}|${y}` : `${y}|${x}`);
    for (let i = 0; i < HAZARD_CLASSES.length; i++) {
      for (let j = i; j < HAZARD_CLASSES.length; j++) {
        const a = HAZARD_CLASSES[i]!;
        const b = HAZARD_CLASSES[j]!;
        expect(incompatible.has(sortedKey(a, b))).toBe(!hazardClassesCompatible(a, b));
      }
    }
  });

  test('a member session reads the same matrix (200 — the read is open to any member)', async () => {
    // The route's load-bearing claim is UNGATED: any member — an operator,
    // not just the owner — sees the card. A future capability check landing
    // here would hide the matrix from operators silently; this pin fails
    // first. The vocabulary must equal the owner's read exactly.
    const email = `operator-${ulid().toLowerCase()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role: 'operator' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    const memberToken = await request(app.getHttpServer())
      .post(`${API}/sign-in`)
      .send({ email, password: 'correct-horse-battery' })
      .expect(200)
      .then((res) => res.body.accessToken as string);

    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/segregation-matrix`)
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(200)
      .expect('Content-Type', /json/);
    expect(res.body.classes).toEqual([...HAZARD_CLASSES]);
    expect(res.body.incompatible).toEqual(enumerateIncompatiblePairs());
  });

  test('a foreign session is refused (403 permission-denied)', async () => {
    // A second tenant's token against the first tenant's path.
    const foreignEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const foreign = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Foreign Co ${ulid()}`, ownerEmail: foreignEmail, password: 'correct-horse-battery' })
      .expect(201);
    createdTenantIds.push(foreign.body.tenant.id as string);
    const foreignToken = await request(app.getHttpServer())
      .post(`${API}/sign-in`)
      .send({ email: foreignEmail, password: 'correct-horse-battery' })
      .expect(200)
      .then((res) => res.body.accessToken as string);

    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/segregation-matrix`)
      .set('Authorization', `Bearer ${foreignToken}`)
      .expect(403);
    expect(res.body).toMatchObject({ status: 403, code: 'permission-denied' });
  });

  test('an unauthenticated call is refused (401)', async () => {
    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/segregation-matrix`)
      .expect(401);
    expect(res.body).toMatchObject({ status: 401, code: 'unauthenticated' });
  });

  test('the OpenAPI document exposes the matrix route (drift guard companion)', async () => {
    const committed = JSON.parse(
      readFileSync(resolve(process.cwd(), 'openapi/openapi.json'), 'utf8') as string,
    ) as { paths: Record<string, unknown> };
    expect(Object.keys(committed.paths)).toContain('/tenants/{tenantId}/catalog/segregation-matrix');
  });
});