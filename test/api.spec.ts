import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app.factory';
import { OpenApiDocumentHolder } from '../src/api/openapi-document.holder';

describe('api shell (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Boots the exact production configuration (prefix, validation,
    // problem-details filter, OpenAPI document).
    app = await createApp(false);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  test('GET /api/v1/health answers with ISO-UTC timestamp', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'wms-be' });
    expect(res.body.time).toMatch(/Z$/);
  });

  test('GET /api/v1/openapi.json serves the versioned OpenAPI document', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/openapi.json').expect(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.info.title).toBe('WMS API');
    expect(res.body.servers).toEqual([{ url: '/api/v1' }]);
    expect(Object.keys(res.body.paths)).toEqual(expect.arrayContaining(['/health', '/echo']));
  });

  test('POST /api/v1/echo round-trips the payload', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/echo')
      .send({ hello: 'contract' })
      .expect(200);
    expect(res.body.echoed).toEqual({ hello: 'contract' });
    expect(res.body.time).toMatch(/Z$/);
  });

  test('POST /api/v1/echo rejects non-object bodies with validation-failed', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/echo')
      .send([1, 2, 3]) // JSON array — a body type the echo schema forbids
      .expect(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 400, code: 'validation-failed' });
    expect(res.body.instance).toBe('/api/v1/echo');
  });

  test('malformed JSON on POST /api/v1/echo returns problem+json validation-failed', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/echo')
      .set('Content-Type', 'application/json')
      .send('{"broken": ')
      .expect(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 400, code: 'validation-failed' });
  });

  test('unhandled faults return internal-error problem details without leaking internals', async () => {
    const holder = app.get(OpenApiDocumentHolder);
    const spy = jest
      .spyOn(holder, 'get')
      .mockImplementation(() => {
        throw new Error('secret internal detail');
      });
    try {
      const res = await request(app.getHttpServer()).get('/api/v1/openapi.json').expect(500);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 500, code: 'internal-error' });
      expect(JSON.stringify(res.body)).not.toContain('secret internal detail');
    } finally {
      spy.mockRestore();
    }
  });

  test('unknown routes return RFC 9457 problem details with machine-readable code', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/nope').expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 404, code: 'not-found', instance: '/api/v1/nope' });
    expect(res.body.type).toContain('/problems/not-found');
  });

  test('openapi/openapi.json on disk matches the document this app serves (contract drift guard)', async () => {
    const served = app.get(OpenApiDocumentHolder).get();
    const committed = readFileSync(resolve(process.cwd(), 'openapi/openapi.json'), 'utf8');
    expect(JSON.parse(committed)).toEqual(JSON.parse(JSON.stringify(served)));
  });
});
