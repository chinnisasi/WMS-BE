import { createHash, type Hash } from 'node:crypto';
import { createGzip, type Gzip } from 'node:zlib';
import { SYSTEM_ACTOR_ID } from '../../shared/primitives/audit';
import { IST_OFFSET_MS } from '../../shared/primitives/time';
import { UTF8_BOM, csvCell } from '../../shared/export/csv';

/**
 * Story 9-3b — the audit export's CSV (RFC 4180): `\r\n` line ends, UTF-8
 * with a byte-order mark (so Excel reads it as UTF-8), one header row.
 * `reference` is never exported (9-3a's rule: it holds idempotency keys,
 * which mean nothing to an owner).
 */
export const AUDIT_EXPORT_CSV_HEADER = [
  'recorded_at',
  'occurred_at',
  'actor_kind',
  'actor_user_id',
  'actor_email',
  'action',
  'target_type',
  'target_id',
] as const;

// Story 5-3a — the BOM and the guarded cell moved to `shared/export/csv.ts`
// (the operational registers share them); re-exported unchanged, so the
// audit export's bytes are identical.
export { UTF8_BOM, csvCell };

/** One audit row as the export reads it (`created_at`/`occurred_at` as stored instants). */
export interface AuditExportCsvRow {
  readonly createdAt: string;
  readonly occurredAt: string;
  readonly actorUserId: string;
  /** The actor's email; null for the system actor or a user the tenant no longer has. */
  readonly actorEmail: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
}

/**
 * An instant as IST ISO-8601 with milliseconds and the `+05:30` offset
 * (`2026-10-13T14:03:07.412+05:30`). IST has no DST, so the offset is fixed.
 */
export function istInstant(instant: string): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) {
    throw new RangeError(`unparseable instant "${instant}"`);
  }
  return `${new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 23)}+05:30`;
}

/** One data line, `\r\n` included. */
export function auditCsvLine(row: AuditExportCsvRow): string {
  const system = row.actorUserId === SYSTEM_ACTOR_ID;
  return `${[
    istInstant(row.createdAt),
    istInstant(row.occurredAt),
    system ? 'system' : 'user',
    row.actorUserId,
    system ? '' : (row.actorEmail ?? ''),
    row.action,
    row.targetType,
    row.targetId,
  ]
    .map(csvCell)
    .join(',')}\r\n`;
}

/** The finished file: the gzipped bytes and the facts the export row records. */
export interface AuditCsvFile {
  readonly gzipped: Buffer;
  readonly rowCount: number;
  /** sha256 (hex) of the UNCOMPRESSED CSV bytes, BOM included. */
  readonly sha256: string;
}

/**
 * Streams CSV lines through `zlib.createGzip` into memory, hashing the
 * uncompressed bytes on the way. The BOM and the header are written on
 * construction. The whole gzipped file is held in memory (PENDING: the
 * measured size is in `tenancy.md`).
 */
export class AuditCsvGzipWriter {
  private readonly gzip: Gzip = createGzip();
  private readonly hash: Hash = createHash('sha256');
  private readonly chunks: Buffer[] = [];
  private readonly done: Promise<void>;
  private rows = 0;

  constructor() {
    this.gzip.on('data', (chunk: Buffer) => this.chunks.push(chunk));
    this.done = new Promise((resolve, reject) => {
      this.gzip.once('end', resolve);
      this.gzip.once('error', reject);
    });
    // `finish()` awaits `done`; a stream error before then (or a discarded
    // run) must not surface as an unhandled rejection.
    this.done.catch(() => undefined);
    this.writeText(`${UTF8_BOM}${AUDIT_EXPORT_CSV_HEADER.join(',')}\r\n`);
  }

  /** Appends rows (the caller keeps the order). */
  async write(rows: readonly AuditExportCsvRow[]): Promise<void> {
    if (rows.length === 0) return;
    const text = rows.map(auditCsvLine).join('');
    this.rows += rows.length;
    if (!this.writeText(text)) {
      // Race `drain` against `error`/`close`: a stream that fails while we
      // wait must reject, never leave the run (and the single-flight tick)
      // hanging.
      await new Promise<void>((resolve, reject) => {
        const settle = (err?: Error | null): void => {
          this.gzip.off('drain', onDrain);
          this.gzip.off('error', onError);
          this.gzip.off('close', onClose);
          if (err) reject(err);
          else resolve();
        };
        const onDrain = (): void => settle();
        const onError = (err: Error): void => settle(err);
        const onClose = (): void => settle(new Error('the gzip stream closed before it drained'));
        this.gzip.once('drain', onDrain);
        this.gzip.once('error', onError);
        this.gzip.once('close', onClose);
      });
    }
  }

  /** Ends the stream and returns the file. */
  async finish(): Promise<AuditCsvFile> {
    this.gzip.end();
    await this.done;
    return { gzipped: Buffer.concat(this.chunks), rowCount: this.rows, sha256: this.hash.digest('hex') };
  }

  /** Discards the stream (a failed or lost run). */
  discard(): void {
    this.gzip.destroy();
  }

  private writeText(text: string): boolean {
    const bytes = Buffer.from(text, 'utf8');
    this.hash.update(bytes);
    return this.gzip.write(bytes);
  }
}
