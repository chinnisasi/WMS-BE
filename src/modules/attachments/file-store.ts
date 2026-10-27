import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Story 2-5a (decision 6, A14, A21) — the file-storage port: the one place
 * the system writes, presigns and deletes attachment bytes. Postgres stays
 * the record (`attachments`); a put cannot roll back with a transaction, so
 * every caller reserves a row first, puts OUTSIDE every transaction, then
 * finalizes (IMPLEMENTATION-GUIDE §8, env-switched ports).
 *
 * Three modes, selected by `FILE_STORE` (a MODE, never a credential — the
 * `ledgerAnchorWormFromEnv` precedent, whose shape this copies):
 *  - `none` (the default — CI and tests): no store. Uploads answer 503
 *    `file-storage-unavailable` (after the replay lookup), the device
 *    snapshot says `receiptPhotos.enabled: false`, reads list no URLs.
 *  - `local`: the S3 adapter against the dev docker-compose MinIO
 *    (`FILE_STORE_S3_ENDPOINT`, path-style; `FILE_STORE_PUBLIC_ENDPOINT` is
 *    the host a browser can reach when the API runs inside docker). Refused
 *    at boot under `NODE_ENV=production`.
 *  - `s3`: S3 in `AWS_REGION` (default ap-south-1), bucket
 *    `ATTACHMENTS_S3_BUCKET`. Credentials come from the SDK's default chain.
 *
 * Downloads are presigned GETs: S3 serves the bytes, the API never proxies
 * them. A URL's `expiresAt` is `min(now + ATTACHMENT_URL_TTL_SECONDS,
 * credentials.expiration)` — a URL never outlives the task role's session.
 */
export const FILE_STORE = 'FILE_STORE' as const;

export const FILE_STORE_MODES = ['none', 'local', 's3'] as const;
export type FileStoreMode = (typeof FILE_STORE_MODES)[number];

export const DEFAULT_FILE_STORE_REGION = 'ap-south-1';
export const DEFAULT_ATTACHMENT_URL_TTL_SECONDS = 300;
/** The longest URL lifetime the boot accepts (1 hour). */
export const MAX_ATTACHMENT_URL_TTL_SECONDS = 3600;

export interface FilePut {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface PresignGet {
  readonly key: string;
  /** Signed into the URL (`response-content-type`) — the DB column's value, never a request's. */
  readonly contentType: string;
  /** An ASCII file name the server built (A14) — never the uploader's `originalname`. */
  readonly filename: string;
}

export interface PresignedUrl {
  readonly url: string;
  /** ISO-8601 instant. */
  readonly expiresAt: string;
}

export interface FileStore {
  readonly mode: FileStoreMode;
  /** Stores the bytes under `key`. A transport or S3 error THROWS. */
  put(input: FilePut): Promise<void>;
  /** A short-lived GET URL. */
  presignGet(input: PresignGet): Promise<PresignedUrl>;
  /** Deletes `key`; deleting a key that does not exist succeeds (S3 semantics). A transport or S3 error THROWS. */
  delete(key: string): Promise<void>;
}

/** The object key: `tenants/<tenantId>/attachments/<attachmentId>` — no names, codes or client data. */
export function attachmentObjectKey(tenantId: string, attachmentId: string): string {
  return `tenants/${tenantId}/attachments/${attachmentId}`;
}

/** The default: no store. Callers check `mode` first; a call is a programming error. */
export class NoneFileStore implements FileStore {
  readonly mode = 'none' as const;

  async put(): Promise<void> {
    throw new Error('FILE_STORE=none — no file store is configured');
  }

  async presignGet(): Promise<PresignedUrl> {
    throw new Error('FILE_STORE=none — no file store is configured');
  }

  async delete(): Promise<void> {
    throw new Error('FILE_STORE=none — no file store is configured');
  }
}

/** Only these characters reach a disposition file name (A14): ASCII letters, digits, `.`, `_`, `-`. */
export function safeDispositionFilename(filename: string): string {
  const cleaned = filename.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned === '' ? 'attachment' : cleaned.slice(0, 120);
}

/**
 * `inline; filename="…"; filename*=UTF-8''…` (RFC 6266 / RFC 5987). The name
 * is sanitised to the ASCII set above, so both forms carry the same text.
 */
export function inlineDisposition(filename: string): string {
  const safe = safeDispositionFilename(filename);
  return `inline; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

/** Clock for presign expiry — assigned by tests (the `rateCardClock` precedent). */
export const fileStoreClock = { now: (): number => Date.now() };

type S3Like = Pick<S3Client, 'send' | 'config'>;

/**
 * The S3 adapter (`s3` and `local`). `presignClient` signs URLs; in `local`
 * mode it targets the public endpoint (the signature covers the host), in
 * `s3` mode it is the same client.
 */
export class S3FileStore implements FileStore {
  constructor(
    readonly mode: 'local' | 's3',
    private readonly client: Pick<S3Client, 'send'>,
    private readonly presignClient: S3Like,
    readonly bucket: string,
    readonly urlTtlSeconds: number,
    /** Injected for tests (`aws-sdk-client-mock` cannot intercept the presigner). */
    private readonly sign: typeof getSignedUrl = getSignedUrl,
  ) {}

  async put(input: FilePut): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.bytes,
        ContentType: input.contentType,
        ContentLength: input.bytes.byteLength,
        // Every stored type is one of the three sanitized rasters (decision 3);
        // S3 serves `inline` only because of that.
        ContentDisposition: 'inline',
        CacheControl: 'private, max-age=300',
        ChecksumAlgorithm: 'SHA256',
      }),
    );
  }

  async presignGet(input: PresignGet): Promise<PresignedUrl> {
    const now = fileStoreClock.now();
    let deadline = now + this.urlTtlSeconds * 1000;
    const credentials = await this.presignClient.config.credentials();
    const expiration = (credentials as { expiration?: Date }).expiration;
    if (expiration instanceof Date && Number.isFinite(expiration.getTime())) {
      deadline = Math.min(deadline, expiration.getTime());
    }
    // S3 rounds expiry to whole seconds; never sign for less than one.
    const expiresIn = Math.max(1, Math.floor((deadline - now) / 1000));
    const url = await this.sign(
      this.presignClient as S3Client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ResponseContentType: input.contentType,
        ResponseContentDisposition: inlineDisposition(input.filename),
      }),
      { expiresIn },
    );
    return { url, expiresAt: new Date(now + expiresIn * 1000).toISOString() };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

const REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d{1,2}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** `ATTACHMENT_URL_TTL_SECONDS` — a positive integer ≤ 3,600; default 300. */
export function parseAttachmentUrlTtlSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_ATTACHMENT_URL_TTL_SECONDS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_ATTACHMENT_URL_TTL_SECONDS) {
    throw new Error(
      `ATTACHMENT_URL_TTL_SECONDS must be a positive integer of seconds, at most ${MAX_ATTACHMENT_URL_TTL_SECONDS} (got "${raw}")`,
    );
  }
  return parsed;
}

function httpUrl(name: string, raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL (got "${value}")`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must be an absolute http(s) URL (got "${value}")`);
  }
  return value.replace(/\/+$/, '');
}

/**
 * Selects the adapter from the env (boot time). `FILE_STORE` unset or `none`
 * → no store; `local` → MinIO (requires `FILE_STORE_S3_ENDPOINT` and
 * `ATTACHMENTS_S3_BUCKET`; refused under `NODE_ENV=production`); `s3` →
 * requires `ATTACHMENTS_S3_BUCKET` and a well-formed `AWS_REGION`. Anything
 * else fails the boot — a deployment that asked for storage must not
 * silently store nothing.
 */
export function fileStoreFromEnv(env: NodeJS.ProcessEnv = process.env): FileStore {
  const raw = env.FILE_STORE;
  const mode = raw === undefined || raw.trim() === '' ? 'none' : raw.trim();
  if (!(FILE_STORE_MODES as readonly string[]).includes(mode)) {
    throw new Error(`FILE_STORE must be one of ${FILE_STORE_MODES.join(', ')} (got "${mode}")`);
  }
  const ttl = parseAttachmentUrlTtlSeconds(env.ATTACHMENT_URL_TTL_SECONDS);
  if (mode === 'none') return new NoneFileStore();
  const bucket = env.ATTACHMENTS_S3_BUCKET?.trim() ?? '';
  if (bucket === '') {
    throw new Error(`FILE_STORE=${mode} requires ATTACHMENTS_S3_BUCKET`);
  }
  if (!BUCKET_RE.test(bucket)) {
    throw new Error(`ATTACHMENTS_S3_BUCKET must be an S3 bucket name (got "${bucket}")`);
  }
  const region =
    env.AWS_REGION === undefined || env.AWS_REGION.trim() === '' ? DEFAULT_FILE_STORE_REGION : env.AWS_REGION.trim();
  if (!REGION_RE.test(region)) {
    throw new Error(`AWS_REGION must be an AWS region such as ap-south-1 (got "${region}")`);
  }
  if (mode === 's3') {
    const client = new S3Client({ region });
    return new S3FileStore('s3', client, client, bucket, ttl);
  }
  // local
  if (env.NODE_ENV === 'production') {
    throw new Error('FILE_STORE=local is the development MinIO and is refused when NODE_ENV=production — use FILE_STORE=s3');
  }
  const endpoint = httpUrl('FILE_STORE_S3_ENDPOINT', env.FILE_STORE_S3_ENDPOINT);
  const publicEndpoint =
    env.FILE_STORE_PUBLIC_ENDPOINT === undefined || env.FILE_STORE_PUBLIC_ENDPOINT.trim() === ''
      ? endpoint
      : httpUrl('FILE_STORE_PUBLIC_ENDPOINT', env.FILE_STORE_PUBLIC_ENDPOINT);
  const client = new S3Client({ region, endpoint, forcePathStyle: true });
  const presignClient =
    publicEndpoint === endpoint ? client : new S3Client({ region, endpoint: publicEndpoint, forcePathStyle: true });
  return new S3FileStore('local', client, presignClient, bucket, ttl);
}

/** The boot check `main.ts` runs (exit 78 on a refusal): the factory, discarded. */
export function assertFileStoreConfigured(env: NodeJS.ProcessEnv = process.env): void {
  fileStoreFromEnv(env);
}

/** The machine code of an S3 (smithy) error: its `name`, else `Code`, else the HTTP status (the ledger-anchor copy). */
export function s3ErrorCode(err: unknown): string {
  if (typeof err !== 'object' || err === null) return 'unknown-error';
  const named = err as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (typeof named.name === 'string' && named.name !== '' && named.name !== 'Error') return named.name;
  if (typeof named.Code === 'string') return named.Code;
  if (typeof named.$metadata?.httpStatusCode === 'number') return `http-${named.$metadata.httpStatusCode}`;
  return 'unknown-error';
}
