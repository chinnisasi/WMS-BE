import type { GetObjectCommand} from '@aws-sdk/client-s3';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import {
  assertFileStoreConfigured,
  attachmentObjectKey,
  fileStoreClock,
  fileStoreFromEnv,
  inlineDisposition,
  NoneFileStore,
  S3FileStore,
  safeDispositionFilename,
} from '../src/modules/attachments/file-store';
import { parseAttachmentPurgeDays } from '../src/modules/attachments/attachments.facade';

// Story 2-5a (decision 6, A14, A21) — the file-store port's adapters against a
// mocked SDK (`aws-sdk-client-mock`, the ledger-anchor precedent) and its
// env factory's boot refusals. The real-S3 proof is test/file-store-minio.spec.ts.

describe('story 2-5a: the file-store port', () => {
  const realNow = fileStoreClock.now;
  afterEach(() => {
    fileStoreClock.now = realNow;
  });

  describe('fileStoreFromEnv (boot)', () => {
    it('defaults to none, and every bad configuration fails the boot naming the variable', () => {
      expect(fileStoreFromEnv({}).mode).toBe('none');
      expect(fileStoreFromEnv({ FILE_STORE: '' }).mode).toBe('none');
      expect(fileStoreFromEnv({ FILE_STORE: 'none' })).toBeInstanceOf(NoneFileStore);
      expect(() => fileStoreFromEnv({ FILE_STORE: 'disk' })).toThrow(/FILE_STORE must be one of none, local, s3 \(got "disk"\)/);
      expect(() => fileStoreFromEnv({ FILE_STORE: 's3' })).toThrow(/FILE_STORE=s3 requires ATTACHMENTS_S3_BUCKET/);
      expect(() => fileStoreFromEnv({ FILE_STORE: 's3', ATTACHMENTS_S3_BUCKET: 'Bad_Bucket' })).toThrow(/ATTACHMENTS_S3_BUCKET must be an S3 bucket name/);
      expect(() => fileStoreFromEnv({ FILE_STORE: 's3', ATTACHMENTS_S3_BUCKET: 'wms-att-1a2b', AWS_REGION: 'mumbai' })).toThrow(/AWS_REGION must be an AWS region/);
      expect(fileStoreFromEnv({ FILE_STORE: 's3', ATTACHMENTS_S3_BUCKET: 'wms-att-1a2b' }).mode).toBe('s3');
      expect(() => fileStoreFromEnv({ ATTACHMENT_URL_TTL_SECONDS: '0' })).toThrow(/ATTACHMENT_URL_TTL_SECONDS/);
      expect(() => fileStoreFromEnv({ ATTACHMENT_URL_TTL_SECONDS: '3601' })).toThrow(/at most 3600/);
      expect(() => fileStoreFromEnv({ ATTACHMENT_URL_TTL_SECONDS: '1.5' })).toThrow(/ATTACHMENT_URL_TTL_SECONDS/);
    });

    it('local is the dev MinIO: it needs an endpoint and is refused under NODE_ENV=production', () => {
      const local = { FILE_STORE: 'local', ATTACHMENTS_S3_BUCKET: 'wms-attachments-dev' };
      expect(() => fileStoreFromEnv(local)).toThrow(/FILE_STORE_S3_ENDPOINT must be an absolute http\(s\) URL/);
      expect(() => fileStoreFromEnv({ ...local, FILE_STORE_S3_ENDPOINT: 'ftp://minio:9000' })).toThrow(/FILE_STORE_S3_ENDPOINT/);
      expect(fileStoreFromEnv({ ...local, FILE_STORE_S3_ENDPOINT: 'http://localhost:9000' }).mode).toBe('local');
      expect(() => fileStoreFromEnv({ ...local, FILE_STORE_S3_ENDPOINT: 'http://localhost:9000', NODE_ENV: 'production' })).toThrow(
        /FILE_STORE=local .* refused when NODE_ENV=production/,
      );
      expect(() => assertFileStoreConfigured({ ...local, FILE_STORE_S3_ENDPOINT: 'http://minio:9000', FILE_STORE_PUBLIC_ENDPOINT: 'nope' })).toThrow(
        /FILE_STORE_PUBLIC_ENDPOINT/,
      );
    });

    it('ATTACHMENT_PURGE_DAYS — a positive integer ≤ 3650, default 30', () => {
      expect(parseAttachmentPurgeDays(undefined)).toBe(30);
      expect(parseAttachmentPurgeDays('7')).toBe(7);
      expect(() => parseAttachmentPurgeDays('0')).toThrow(/ATTACHMENT_PURGE_DAYS/);
      expect(() => parseAttachmentPurgeDays('3651')).toThrow(/ATTACHMENT_PURGE_DAYS/);
    });
  });

  describe('the S3 adapter', () => {
    const s3 = mockClient(S3Client);
    beforeEach(() => s3.reset());

    function store(credentials: { expiration?: Date } = {}, ttl = 300): { store: S3FileStore; signed: { command: GetObjectCommand; expiresIn: number }[] } {
      const signed: { command: GetObjectCommand; expiresIn: number }[] = [];
      const client = new S3Client({ region: 'ap-south-1' });
      const presignClient = {
        send: client.send.bind(client),
        config: { credentials: async () => ({ accessKeyId: 'AKIA', secretAccessKey: 'secret', ...credentials }) },
      } as unknown as S3Client;
      const sign = (async (_client: unknown, command: GetObjectCommand, options?: { expiresIn?: number }) => {
        signed.push({ command, expiresIn: options?.expiresIn ?? -1 });
        return `https://bucket.s3.ap-south-1.amazonaws.com/${command.input.Key}?X-Amz-Signature=x`;
      }) as never;
      return { store: new S3FileStore('s3', client, presignClient, 'wms-att-1a2b', ttl, sign), signed };
    }

    it('put sends the bytes with the sanitized type fixed, inline, and a checksum', async () => {
      s3.on(PutObjectCommand).resolves({});
      const { store: adapter } = store();
      const key = attachmentObjectKey('t-1', 'a-1');
      expect(key).toBe('tenants/t-1/attachments/a-1');
      await adapter.put({ key, bytes: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' });
      const calls = s3.commandCalls(PutObjectCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input).toMatchObject({
        Bucket: 'wms-att-1a2b',
        Key: key,
        ContentType: 'image/jpeg',
        ContentLength: 3,
        ContentDisposition: 'inline',
        ChecksumAlgorithm: 'SHA256',
      });
    });

    it('presign signs the DB content type and a server-built ASCII disposition; expiry = min(now + TTL, credentials.expiration)', async () => {
      fileStoreClock.now = () => Date.parse('2026-10-26T10:00:00.000Z');
      const { store: adapter, signed } = store();
      const url = await adapter.presignGet({ key: 'tenants/t/attachments/a', contentType: 'image/png', filename: 'GRN-0001-L2-1.png' });
      expect(url.expiresAt).toBe('2026-10-26T10:05:00.000Z');
      expect(signed[0]!.expiresIn).toBe(300);
      expect(signed[0]!.command.input).toMatchObject({
        Bucket: 'wms-att-1a2b',
        Key: 'tenants/t/attachments/a',
        ResponseContentType: 'image/png',
        ResponseContentDisposition: `inline; filename="GRN-0001-L2-1.png"; filename*=UTF-8''GRN-0001-L2-1.png`,
      });

      // A task-role session ending in 90 s caps the URL at 90 s.
      const short = store({ expiration: new Date(Date.parse('2026-10-26T10:01:30.000Z')) });
      const capped = await short.store.presignGet({ key: 'k', contentType: 'image/jpeg', filename: 'x.jpg' });
      expect(short.signed[0]!.expiresIn).toBe(90);
      expect(capped.expiresAt).toBe('2026-10-26T10:01:30.000Z');
      // A session that already ended still signs for one second (never 0).
      const dead = store({ expiration: new Date(Date.parse('2026-10-26T09:00:00.000Z')) });
      await dead.store.presignGet({ key: 'k', contentType: 'image/jpeg', filename: 'x.jpg' });
      expect(dead.signed[0]!.expiresIn).toBe(1);
    });

    it('a hostile file name never reaches the header: quotes, CR/LF, path and non-ASCII are replaced', () => {
      expect(safeDispositionFilename('a"b\r\nc/../d é.jpg')).toBe('a_b__c_.._d__.jpg');
      expect(safeDispositionFilename('...')).toBe('attachment');
      expect(inlineDisposition('x"; filename=evil.html')).toBe(`inline; filename="x___filename_evil.html"; filename*=UTF-8''x___filename_evil.html`);
    });

    it('the real presigner signs response-content-type and -disposition into the URL, expiring at the TTL', async () => {
      const client = new S3Client({ region: 'ap-south-1', credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' } });
      const adapter = new S3FileStore('s3', client, client, 'wms-att-1a2b', 300);
      const url = new URL((await adapter.presignGet({ key: 'tenants/t/attachments/a', contentType: 'image/webp', filename: 'GRN-1-L1-1.webp' })).url);
      expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(url.searchParams.get('response-content-type')).toBe('image/webp');
      expect(url.searchParams.get('response-content-disposition')).toBe(`inline; filename="GRN-1-L1-1.webp"; filename*=UTF-8''GRN-1-L1-1.webp`);
      expect(url.pathname).toBe('/tenants/t/attachments/a');
    });

    it('delete sends DeleteObject; a transport error throws (the sweep retries)', async () => {
      s3.on(DeleteObjectCommand).resolvesOnce({}).rejectsOnce(Object.assign(new Error('boom'), { name: 'ServiceUnavailable' }));
      const { store: adapter } = store();
      await adapter.delete('tenants/t/attachments/a');
      await expect(adapter.delete('tenants/t/attachments/b')).rejects.toThrow('boom');
      expect(s3.commandCalls(DeleteObjectCommand).map((call) => call.args[0].input.Key)).toEqual(['tenants/t/attachments/a', 'tenants/t/attachments/b']);
    });

    it('the none store refuses every call (callers check mode first)', async () => {
      const none = new NoneFileStore();
      await expect(none.put()).rejects.toThrow(/FILE_STORE=none/);
      await expect(none.presignGet()).rejects.toThrow(/FILE_STORE=none/);
      await expect(none.delete()).rejects.toThrow(/FILE_STORE=none/);
    });
  });
});
