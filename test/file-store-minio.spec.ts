import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { ulid } from '../src/shared/primitives/ids';
import { fileStoreFromEnv } from '../src/modules/attachments/file-store';
import { sanitizeImage } from '../src/modules/attachments/image-sanitize';

// Story 2-5a (A14, AC "EXIF stripped") — the S3 adapter against a REAL S3 API
// (MinIO): put, presign, and a plain fetch of the presigned URL. Runs in the
// `minio-integration` CI job; skips itself when FILE_STORE_MINIO_TEST_ENDPOINT
// is unset (`docker compose up -d minio` locally, with AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY = the compose credentials).
const endpoint = process.env.FILE_STORE_MINIO_TEST_ENDPOINT;
const maybe = endpoint === undefined || endpoint === '' ? describe.skip : describe;

maybe('story 2-5a: the file store against MinIO', () => {
  const bucket = `wms-it-${ulid().toLowerCase().slice(-10)}`;

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID ??= 'wms-minio';
    process.env.AWS_SECRET_ACCESS_KEY ??= 'wms-minio-secret';
    const admin = new S3Client({ region: 'ap-south-1', endpoint: endpoint!, forcePathStyle: true });
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  it('a GPS-tagged JPEG, sanitized, put and presigned, downloads with the signed type and disposition and no APP1', async () => {
    const store = fileStoreFromEnv({
      FILE_STORE: 'local',
      ATTACHMENTS_S3_BUCKET: bucket,
      FILE_STORE_S3_ENDPOINT: endpoint!,
      AWS_REGION: 'ap-south-1',
    });
    expect(store.mode).toBe('local');
    const raw = readFileSync(join(__dirname, 'fixtures', 'images', 'gps-exif-icc.jpg'));
    expect(raw.includes(Buffer.from('Exif\0\0'))).toBe(true); // the fixture really carries EXIF
    const clean = sanitizeImage(raw);
    const key = `tenants/it/attachments/${ulid()}`;
    await store.put({ key, bytes: clean.bytes, contentType: clean.contentType });

    const signed = await store.presignGet({ key, contentType: 'image/jpeg', filename: 'GRN-0001-L2-1.jpg' });
    const response = await fetch(signed.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('content-disposition')).toBe(`inline; filename="GRN-0001-L2-1.jpg"; filename*=UTF-8''GRN-0001-L2-1.jpg`);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(clean.bytes)).toBe(true);
    // No APP1 segment (FF E1) and no Exif header anywhere in the stored bytes.
    expect(body.includes(Buffer.from('Exif\0\0'))).toBe(false);
    let offset = 2;
    while (offset + 4 <= body.length && body[offset] === 0xff && body[offset + 1] !== 0xda) {
      expect(body[offset + 1]).not.toBe(0xe1);
      offset += 2 + body.readUInt16BE(offset + 2);
    }

    // A tampered signature is refused; a deleted object is gone.
    const tampered = new URL(signed.url);
    tampered.searchParams.set('X-Amz-Signature', '0'.repeat(64));
    expect((await fetch(tampered)).status).toBe(403);
    await store.delete(key);
    expect((await fetch(signed.url)).status).toBe(404);
  });
});
