import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DEFAULT_LEDGER_ANCHOR_RETENTION_DAYS,
  NoneLedgerAnchorWormStore,
  S3LedgerAnchorWormStore,
  ledgerAnchorWormFromEnv,
  parseLedgerAnchorRetentionDays,
  retainUntilOf,
  s3ErrorCode,
  wormObjectBody,
  wormObjectKey,
  type WormAnchor,
} from '../src/modules/inventory/ledger-anchor-worm';

// Story 9-3c — the S3 WORM adapter, unit-tested against a mocked SDK client
// (no bucket, no network): what the put sends (Object Lock COMPLIANCE, the
// retain-until date, the SHA-256 checksum Object Lock requires), how a
// read-back maps S3's answers, and what the env selector refuses at boot.

const ANCHOR: WormAnchor = {
  id: '01923456-7890-7abc-8def-0123456789ab',
  tenantId: '01900000-0000-7000-8000-00000000000a',
  warehouseId: '01900000-0000-7000-8000-00000000000b',
  kind: 'verified',
  fromSeq: 11,
  toSeq: 20,
  digest: 'ab'.repeat(32),
  anchoredAt: '2026-10-14T05:30:00.000Z',
};

/** The slice of the SDK's streaming body the adapter reads. */
function body(text: string) {
  return { transformToString: async () => text };
}

describe('the S3 WORM adapter (story 9-3c, mocked SDK)', () => {
  const s3 = mockClient(S3Client);

  beforeEach(() => {
    s3.reset();
  });

  it('put: one PutObject under Object Lock COMPLIANCE with the retain-until date and a SHA-256 checksum; resolves the version', async () => {
    s3.on(PutObjectCommand).resolves({ VersionId: 'ver-1' });
    const store = new S3LedgerAnchorWormStore(new S3Client({ region: 'ap-south-1' }), 'anchors-bucket', 2557);
    const ref = await store.put(ANCHOR);
    const calls = s3.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.Bucket).toBe('anchors-bucket');
    expect(input.Key).toBe(`ledger-anchors/${ANCHOR.tenantId}/${ANCHOR.warehouseId}/000000000020-${ANCHOR.id}.json`);
    expect(input.ObjectLockMode).toBe('COMPLIANCE');
    expect(input.ObjectLockRetainUntilDate).toEqual(new Date('2033-10-14T05:30:00.000Z'));
    expect(input.ChecksumAlgorithm).toBe('SHA256');
    expect(input.ContentType).toBe('application/json');
    // The body is the anchor with its kind, as canonical JSON (fixed key order).
    expect(input.Body).toBe(
      `{"id":"${ANCHOR.id}","tenantId":"${ANCHOR.tenantId}","warehouseId":"${ANCHOR.warehouseId}","kind":"verified","fromSeq":11,"toSeq":20,"digest":"${ANCHOR.digest}","anchoredAt":"2026-10-14T05:30:00.000Z"}`,
    );
    expect(ref).toEqual({ bucket: 'anchors-bucket', objectKey: input.Key, versionId: 'ver-1', retainUntil: '2033-10-14T05:30:00.000Z' });
  });

  it('put: an answer with no version id (versioning off) throws — a copy is never recorded without a version', async () => {
    s3.on(PutObjectCommand).resolves({});
    const store = new S3LedgerAnchorWormStore(new S3Client({ region: 'ap-south-1' }), 'b', 1);
    await expect(store.put(ANCHOR)).rejects.toMatchObject({ name: 'NoVersionId' });
  });

  it('put: an S3 refusal (a bucket without Object Lock) propagates with its code', async () => {
    s3.on(PutObjectCommand).rejects(Object.assign(new Error('Bucket is missing Object Lock Configuration'), { name: 'InvalidRequest' }));
    const store = new S3LedgerAnchorWormStore(new S3Client({ region: 'ap-south-1' }), 'b', 1);
    const caught = await store.put(ANCHOR).catch((err: unknown) => err);
    expect(s3ErrorCode(caught)).toBe('InvalidRequest');
  });

  it('get: reads the exact version and returns its digest and range', async () => {
    s3.on(GetObjectCommand).resolves({ Body: body(wormObjectBody(ANCHOR)) as never });
    const store = new S3LedgerAnchorWormStore(new S3Client({ region: 'ap-south-1' }), 'b', 1);
    const back = await store.get({ bucket: 'b', objectKey: wormObjectKey(ANCHOR), versionId: 'ver-1' });
    expect(back).toEqual({ id: ANCHOR.id, kind: 'verified', anchoredAt: ANCHOR.anchoredAt, digest: ANCHOR.digest, fromSeq: 11, toSeq: 20 });
    expect(s3.commandCalls(GetObjectCommand)[0]!.args[0].input).toEqual({ Bucket: 'b', Key: wormObjectKey(ANCHOR), VersionId: 'ver-1' });
  });

  it('get: NoSuchKey and NoSuchVersion are "missing"; any other error (a 5xx, a timeout) throws — never a break', async () => {
    const store = new S3LedgerAnchorWormStore(new S3Client({ region: 'ap-south-1' }), 'b', 1);
    for (const name of ['NoSuchKey', 'NoSuchVersion']) {
      s3.reset();
      s3.on(GetObjectCommand).rejects(Object.assign(new Error(name), { name }));
      expect(await store.get({ bucket: 'b', objectKey: 'k', versionId: 'v' })).toBe('missing');
    }
    s3.reset();
    s3.on(GetObjectCommand).rejects(Object.assign(new Error('We encountered an internal error'), { name: 'InternalError', $metadata: { httpStatusCode: 500 } }));
    await expect(store.get({ bucket: 'b', objectKey: 'k', versionId: 'v' })).rejects.toMatchObject({ name: 'InternalError' });
  });

  it('get: an object that no longer parses reads as a different digest (a mismatch), not a crash', async () => {
    s3.on(GetObjectCommand).resolves({ Body: body('not json') as never });
    const store = new S3LedgerAnchorWormStore(new S3Client({ region: 'ap-south-1' }), 'b', 1);
    const back = await store.get({ bucket: 'b', objectKey: 'k', versionId: 'v' });
    expect(back).not.toBe('missing');
    expect((back as { digest: string }).digest).not.toBe(ANCHOR.digest);
  });

  it('the env selector: none by default; s3 needs a bucket, a well-formed region and a positive retention — else the boot fails', () => {
    expect(ledgerAnchorWormFromEnv({})).toBeInstanceOf(NoneLedgerAnchorWormStore);
    expect(ledgerAnchorWormFromEnv({ LEDGER_ANCHOR_WORM: 'none' }).mode).toBe('none');
    expect(() => ledgerAnchorWormFromEnv({ LEDGER_ANCHOR_WORM: 'glacier' })).toThrow(/LEDGER_ANCHOR_WORM/);
    expect(() => ledgerAnchorWormFromEnv({ LEDGER_ANCHOR_WORM: 's3' })).toThrow(/LEDGER_ANCHOR_S3_BUCKET/);
    expect(() => ledgerAnchorWormFromEnv({ LEDGER_ANCHOR_WORM: 's3', LEDGER_ANCHOR_S3_BUCKET: 'b', AWS_REGION: 'mumbai' })).toThrow(/AWS_REGION/);
    expect(() => ledgerAnchorWormFromEnv({ LEDGER_ANCHOR_WORM: 's3', LEDGER_ANCHOR_S3_BUCKET: 'b', LEDGER_ANCHOR_RETENTION_DAYS: '0' })).toThrow(/LEDGER_ANCHOR_RETENTION_DAYS/);
    expect(() => ledgerAnchorWormFromEnv({ LEDGER_ANCHOR_WORM: 's3', LEDGER_ANCHOR_S3_BUCKET: 'b', LEDGER_ANCHOR_RETENTION_DAYS: '36501' })).toThrow(/LEDGER_ANCHOR_RETENTION_DAYS/);
    expect(() => ledgerAnchorWormFromEnv({ LEDGER_ANCHOR_WORM: 's3', LEDGER_ANCHOR_S3_BUCKET: 'b', LEDGER_ANCHOR_RETENTION_DAYS: 'x' })).toThrow(/LEDGER_ANCHOR_RETENTION_DAYS/);
    expect(parseLedgerAnchorRetentionDays('36500')).toBe(36500);
    const store = ledgerAnchorWormFromEnv({ LEDGER_ANCHOR_WORM: 's3', LEDGER_ANCHOR_S3_BUCKET: 'anchors' }) as S3LedgerAnchorWormStore;
    expect(store.mode).toBe('s3');
    expect(store.bucket).toBe('anchors');
    expect(store.retentionDays).toBe(DEFAULT_LEDGER_ANCHOR_RETENTION_DAYS);
    expect(parseLedgerAnchorRetentionDays('30')).toBe(30);
  });

  it('none: never writes — a call is a programming error', async () => {
    const none = new NoneLedgerAnchorWormStore();
    await expect(none.put()).rejects.toThrow(/LEDGER_ANCHOR_WORM=none/);
    await expect(none.get()).rejects.toThrow(/LEDGER_ANCHOR_WORM=none/);
  });

  it('retain-until is anchoredAt + the retention days (7 years by default)', () => {
    expect(DEFAULT_LEDGER_ANCHOR_RETENTION_DAYS).toBe(2557);
    expect(retainUntilOf('2026-10-14T00:00:00.000Z', 2557)).toBe('2033-10-14T00:00:00.000Z');
  });
});
