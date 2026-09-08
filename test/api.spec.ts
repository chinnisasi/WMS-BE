import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app.factory';

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
      .expect(201);
    expect(res.body.echoed).toEqual({ hello: 'contract' });
    expect(res.body.time).toMatch(/Z$/);
  });

  test('unknown routes return RFC 9457 problem details with machine-readable code', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/nope').expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 404, code: 'not-found' });
    expect(res.body.type).toContain('/problems/not-found');
  });
});