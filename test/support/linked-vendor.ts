import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ulid } from '../../src/shared/primitives/ids';

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

export interface LinkedVendorOptions {
  readonly code: string;
  readonly name: string;
  /**
   * The clients to link the vendor to. Omitted: EVERY client the tenant
   * holds at the time of the call (a suite that creates a client later links
   * it with `linkVendor`).
   */
  readonly clientIds?: readonly string[];
  /** Make the vendor the default of each linked client. */
  readonly isDefault?: boolean;
  readonly gstin?: string;
}

/**
 * Story 1-3 — the suites' vendor fixture. A purchase order's vendor must be
 * an active partner with the vendor role AND an active vendor link to the
 * PO's client, so a suite that used to `POST /vendors` now creates the
 * partner through the real surface and links it. Returns the partner id
 * (the PO's `vendorId`).
 */
export async function createLinkedVendor(
  app: INestApplication,
  tenantId: string,
  token: string,
  options: LinkedVendorOptions,
): Promise<string> {
  const created = await request(app.getHttpServer())
    .post(`${API}/${tenantId}/partners`)
    .set('Authorization', `Bearer ${token}`)
    .set(KEY_HEADER, ulid())
    .send({ code: options.code, name: options.name, roles: ['vendor'], ...(options.gstin === undefined ? {} : { gstin: options.gstin }) })
    .expect(201);
  const partnerId = created.body.partner.id as string;
  const clientIds = options.clientIds ?? (await tenantClientIds(app, tenantId, token));
  for (const clientId of clientIds) {
    await linkVendor(app, tenantId, token, partnerId, clientId, options.isDefault === true);
  }
  return partnerId;
}

/** Links an existing vendor partner to one more client (optionally as its default). */
export async function linkVendor(
  app: INestApplication,
  tenantId: string,
  token: string,
  partnerId: string,
  clientId: string,
  isDefault = false,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post(`${API}/${tenantId}/partners/${partnerId}/links`)
    .set('Authorization', `Bearer ${token}`)
    .set(KEY_HEADER, ulid())
    .send({ clientId, role: 'vendor', ...(isDefault ? { isDefault: true } : {}) })
    .expect(201);
  const link = (res.body.partner.links as { id: string; clientId: string; role: string }[]).find(
    (row) => row.clientId === clientId && row.role === 'vendor',
  )!;
  return link.id;
}

/** Every client id of the tenant (the self client included). */
export async function tenantClientIds(app: INestApplication, tenantId: string, token: string): Promise<string[]> {
  const res = await request(app.getHttpServer())
    .get(`${API}/${tenantId}/clients`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  return (res.body.items as { id: string }[]).map((client) => client.id);
}
