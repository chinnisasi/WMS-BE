import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ulid } from '../../src/shared/primitives/ids';

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

/**
 * Story 12-3's secure-SKU fixture: import a fresh untracked SKU through the
 * real surface, then PATCH its storage class to `secure`. The patch comes
 * BEFORE any stock exists — the 12-1 class-edit guard refuses a class change
 * over live stock. The fixture only: the bins, the seeds (the named
 * `stock.adjust` bypass) and the surrounding arms stay in the calling suite.
 */
export async function importSecureSku(
  app: INestApplication,
  tenantId: string,
  ownerToken: string,
  code: string,
): Promise<string> {
  const csv = [
    'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode',
    `${code},Item ${code},pcs,,1800,,false,false,,,`,
  ].join('\n');
  await request(app.getHttpServer())
    .post(`${API}/${tenantId}/catalog/imports`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .set(KEY_HEADER, ulid())
    .field('mode', 'initial')
    .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
    .expect(201);
  const skus = await request(app.getHttpServer())
    .get(`${API}/${tenantId}/catalog/skus`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  const skuId = (skus.body.items as { code: string; id: string }[]).find(
    (item) => item.code === code,
  )!.id as string;
  await request(app.getHttpServer())
    .patch(`${API}/${tenantId}/catalog/skus/${skuId}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .set(KEY_HEADER, ulid())
    .send({ storageClass: 'secure' })
    .expect(200);
  return skuId;
}