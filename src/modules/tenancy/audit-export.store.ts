import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { auditExportFiles } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';

/**
 * Story 9-3b — where an audit export's file lives (human decision 1,
 * 2026-10-13): a PORT, so 9-3c's object storage can replace the
 * implementation without touching the runner or the download route. Every
 * method takes the caller's tenant transaction — a `put` commits (or rolls
 * back) with the `ready` transition, a `remove` with the `expired` one.
 */
export interface AuditExportStore {
  /** Stores the export's gzipped CSV bytes. */
  put(tx: TenantTx, tenantId: string, exportId: string, bytes: Buffer): Promise<void>;
  /** The stored bytes, or null when none are stored. */
  open(tx: TenantTx, tenantId: string, exportId: string): Promise<Buffer | null>;
  /** Removes the stored bytes (a no-op when none are stored). */
  remove(tx: TenantTx, tenantId: string, exportId: string): Promise<void>;
}

/** DI token for the store port. */
export const AUDIT_EXPORT_STORE = 'AUDIT_EXPORT_STORE' as const;

/**
 * The Postgres implementation: the bytes in `audit_export_files` (one row per
 * export, `bytea`), a table of its own so listing exports never reads them.
 */
@Injectable()
export class PostgresAuditExportStore implements AuditExportStore {
  async put(tx: TenantTx, tenantId: string, exportId: string, bytes: Buffer): Promise<void> {
    await tx.insert(auditExportFiles).values({ exportId, tenantId, content: bytes });
  }

  async open(tx: TenantTx, tenantId: string, exportId: string): Promise<Buffer | null> {
    const rows = await tx
      .select({ content: auditExportFiles.content })
      .from(auditExportFiles)
      .where(and(eq(auditExportFiles.tenantId, tenantId), eq(auditExportFiles.exportId, exportId)))
      .limit(1);
    const content = rows[0]?.content;
    return content === undefined ? null : Buffer.from(content);
  }

  async remove(tx: TenantTx, tenantId: string, exportId: string): Promise<void> {
    await tx
      .delete(auditExportFiles)
      .where(and(eq(auditExportFiles.tenantId, tenantId), eq(auditExportFiles.exportId, exportId)));
  }
}
