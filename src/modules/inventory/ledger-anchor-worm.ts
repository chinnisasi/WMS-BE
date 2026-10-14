import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { LedgerAnchorKind } from '../../shared/db/schema';

/**
 * Story 9-3c (AD-16, human decision 2) — the WORM port: the one thing in the
 * system that writes an anchor to write-once storage. Postgres stays the
 * anchor's source (`ledger_anchors`, committed in the anchor transaction);
 * the integrity worker COPIES each committed anchor here afterwards — an S3
 * `PutObject` cannot roll back with a transaction — and records the object
 * version in the append-only `ledger_anchor_worm_copies`.
 *
 * Two adapters, selected by the `LEDGER_ANCHOR_WORM` env MODE (never a
 * credential), the `pushGatewayFromEnv` precedent:
 *  - `none` (the default — dev and CI): no WORM store; the worker skips the
 *    copy and the read-back, and the web reads "WORM storage not configured";
 *  - `s3` — S3 with Object Lock (COMPLIANCE mode) in `AWS_REGION` (default
 *    ap-south-1). Credentials come from the SDK's default chain.
 *
 * A missing bucket, a bad region or a bad retention value fails the BOOT.
 * Whether the bucket really has Object Lock can only be discovered at the
 * first put (S3 refuses an Object Lock header on a bucket without it): the
 * put fails, the worker logs its error code and retries next tick, and the
 * anchor counts in `wormPending`.
 */
export const LEDGER_ANCHOR_WORM_STORE = 'LEDGER_ANCHOR_WORM_STORE' as const;

export const LEDGER_ANCHOR_WORM_MODES = ['none', 's3'] as const;
export type LedgerAnchorWormMode = (typeof LEDGER_ANCHOR_WORM_MODES)[number];

/** The default retention: 7 years (2,557 days — AD-16 / NFR-5's 7-year audit horizon). */
export const DEFAULT_LEDGER_ANCHOR_RETENTION_DAYS = 2557;
export const DEFAULT_LEDGER_ANCHOR_REGION = 'ap-south-1';

/** The anchor as it is written to WORM (the object body, canonical JSON). */
export interface WormAnchor {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly kind: LedgerAnchorKind;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly digest: string;
  readonly anchoredAt: string;
}

/** Where one copy lives: the bucket, the key, the S3 object version, and its lock. */
export interface WormRef {
  readonly bucket: string;
  readonly objectKey: string;
  readonly versionId: string;
  /** ISO-8601 — the Object Lock retain-until date. */
  readonly retainUntil: string;
}

/** What a read-back found in the stored object (compared against the anchor row). */
export interface WormReadBack {
  readonly id: string;
  readonly kind: string;
  readonly anchoredAt: string;
  readonly digest: string;
  readonly fromSeq: number;
  readonly toSeq: number;
}

export interface LedgerAnchorWormStore {
  readonly mode: LedgerAnchorWormMode;
  /** Writes one anchor under Object Lock; resolves its version. A transport or S3 error THROWS. */
  put(anchor: WormAnchor): Promise<WormRef>;
  /**
   * Reads one copy back by its exact version. `'missing'` = the key or the
   * version does not exist (`NoSuchKey`/`NoSuchVersion` — a WORM break). A
   * transport error or any other S3 error THROWS (logged, retried — never a
   * break).
   */
  get(ref: Pick<WormRef, 'bucket' | 'objectKey' | 'versionId'>): Promise<WormReadBack | 'missing'>;
}

/** The object key: `ledger-anchors/<tenant>/<warehouse>/<toSeq padded to 12>-<anchorId>.json`. */
export function wormObjectKey(anchor: Pick<WormAnchor, 'tenantId' | 'warehouseId' | 'toSeq' | 'id'>): string {
  return `ledger-anchors/${anchor.tenantId}/${anchor.warehouseId}/${String(anchor.toSeq).padStart(12, '0')}-${anchor.id}.json`;
}

/** The object body: the anchor with its kind, as canonical JSON (a fixed literal key order). */
export function wormObjectBody(anchor: WormAnchor): string {
  return JSON.stringify({
    id: anchor.id,
    tenantId: anchor.tenantId,
    warehouseId: anchor.warehouseId,
    kind: anchor.kind,
    fromSeq: anchor.fromSeq,
    toSeq: anchor.toSeq,
    digest: anchor.digest,
    anchoredAt: anchor.anchoredAt,
  });
}

/** `anchoredAt + days`, as an ISO instant. */
export function retainUntilOf(anchoredAt: string, retentionDays: number): string {
  return new Date(Date.parse(anchoredAt) + retentionDays * 86_400_000).toISOString();
}

/** The default: no WORM store. The worker never calls it (it checks `mode`); a call is a programming error. */
export class NoneLedgerAnchorWormStore implements LedgerAnchorWormStore {
  readonly mode = 'none' as const;

  async put(): Promise<WormRef> {
    throw new Error('LEDGER_ANCHOR_WORM=none — no WORM store is configured');
  }

  async get(): Promise<WormReadBack | 'missing'> {
    throw new Error('LEDGER_ANCHOR_WORM=none — no WORM store is configured');
  }
}

/** An S3 error whose code says the object or its version does not exist. */
const MISSING_CODES = new Set(['NoSuchKey', 'NoSuchVersion']);

/** The S3 adapter: `PutObject` under Object Lock COMPLIANCE; `GetObject` by version. */
export class S3LedgerAnchorWormStore implements LedgerAnchorWormStore {
  readonly mode = 's3' as const;

  constructor(
    private readonly client: Pick<S3Client, 'send'>,
    readonly bucket: string,
    readonly retentionDays: number,
  ) {}

  async put(anchor: WormAnchor): Promise<WormRef> {
    const objectKey = wormObjectKey(anchor);
    const retainUntil = retainUntilOf(anchor.anchoredAt, this.retentionDays);
    const response = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: wormObjectBody(anchor),
        ContentType: 'application/json',
        ObjectLockMode: 'COMPLIANCE',
        ObjectLockRetainUntilDate: new Date(retainUntil),
        // Object Lock requires an integrity header on the put; a SHA-256
        // checksum satisfies it (Content-MD5 is the other option).
        ChecksumAlgorithm: 'SHA256',
      }),
    );
    const versionId = response.VersionId;
    if (versionId === undefined || versionId === '' || versionId === 'null') {
      // Object Lock implies versioning; an unversioned answer means the
      // bucket is not what the deployment says it is. Never record a copy
      // that names no version.
      throw Object.assign(new Error(`S3 put of ${objectKey} returned no version id — is versioning (Object Lock) enabled on ${this.bucket}?`), {
        name: 'NoVersionId',
      });
    }
    return { bucket: this.bucket, objectKey, versionId, retainUntil };
  }

  async get(ref: Pick<WormRef, 'bucket' | 'objectKey' | 'versionId'>): Promise<WormReadBack | 'missing'> {
    let text: string;
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: ref.bucket, Key: ref.objectKey, VersionId: ref.versionId }),
      );
      text = response.Body === undefined ? '' : await response.Body.transformToString('utf8');
    } catch (err) {
      if (MISSING_CODES.has(s3ErrorCode(err))) {
        return 'missing';
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // An object that no longer parses is not the anchor that was written.
      return { id: '', kind: '', anchoredAt: '', digest: '<unreadable object>', fromSeq: -1, toSeq: -1 };
    }
    const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
    const text_ = (key: string): string => (typeof body[key] === 'string' ? (body[key] as string) : '');
    return {
      id: text_('id'),
      kind: text_('kind'),
      anchoredAt: text_('anchoredAt'),
      digest: typeof body.digest === 'string' ? body.digest : '<no digest>',
      fromSeq: typeof body.fromSeq === 'number' ? body.fromSeq : -1,
      toSeq: typeof body.toSeq === 'number' ? body.toSeq : -1,
    };
  }
}

/** The machine code of an S3 (smithy) error: its `name`, else `Code`, else the HTTP status. */
export function s3ErrorCode(err: unknown): string {
  if (typeof err !== 'object' || err === null) return 'unknown-error';
  const named = err as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (typeof named.name === 'string' && named.name !== '' && named.name !== 'Error') return named.name;
  if (typeof named.Code === 'string') return named.Code;
  if (typeof named.$metadata?.httpStatusCode === 'number') return `http-${named.$metadata.httpStatusCode}`;
  return 'unknown-error';
}

const REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d{1,2}$/;

/**
 * Selects the adapter from the env (boot time): `LEDGER_ANCHOR_WORM` unset
 * or `none` → no WORM store; `s3` → S3, which REQUIRES
 * `LEDGER_ANCHOR_S3_BUCKET`, a well-formed `AWS_REGION` (default
 * ap-south-1) and a positive integer `LEDGER_ANCHOR_RETENTION_DAYS`
 * (default 2,557). Anything else fails the boot — a deployment that asked
 * for WORM must not silently copy nothing.
 */
export function ledgerAnchorWormFromEnv(env: NodeJS.ProcessEnv = process.env): LedgerAnchorWormStore {
  const raw = env.LEDGER_ANCHOR_WORM;
  const mode = raw === undefined || raw === '' ? 'none' : raw;
  if (!(LEDGER_ANCHOR_WORM_MODES as readonly string[]).includes(mode)) {
    throw new Error(`LEDGER_ANCHOR_WORM must be one of ${LEDGER_ANCHOR_WORM_MODES.join(', ')} (got "${mode}")`);
  }
  if (mode === 'none') return new NoneLedgerAnchorWormStore();
  const bucket = env.LEDGER_ANCHOR_S3_BUCKET?.trim() ?? '';
  if (bucket === '') {
    throw new Error('LEDGER_ANCHOR_WORM=s3 requires LEDGER_ANCHOR_S3_BUCKET');
  }
  const region = env.AWS_REGION === undefined || env.AWS_REGION.trim() === '' ? DEFAULT_LEDGER_ANCHOR_REGION : env.AWS_REGION.trim();
  if (!REGION_RE.test(region)) {
    throw new Error(`AWS_REGION must be an AWS region such as ap-south-1 (got "${region}")`);
  }
  const retentionDays = parseLedgerAnchorRetentionDays(env.LEDGER_ANCHOR_RETENTION_DAYS);
  return new S3LedgerAnchorWormStore(new S3Client({ region }), bucket, retentionDays);
}

/** The longest retention the boot accepts (100 years) — a typo'd retention would lock objects effectively forever. */
export const MAX_LEDGER_ANCHOR_RETENTION_DAYS = 36_500;

/** `LEDGER_ANCHOR_RETENTION_DAYS` — a positive integer of days ≤ 36,500; default 2,557 (7 years). */
export function parseLedgerAnchorRetentionDays(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_LEDGER_ANCHOR_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LEDGER_ANCHOR_RETENTION_DAYS) {
    throw new Error(`LEDGER_ANCHOR_RETENTION_DAYS must be a positive integer of days, at most ${MAX_LEDGER_ANCHOR_RETENTION_DAYS} (got "${raw}")`);
  }
  return parsed;
}
