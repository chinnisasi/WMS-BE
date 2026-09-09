import { Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { LedgerAnchor } from '../../shared/db/schema';
import { ledgerAnchors } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { uuidv7 } from '../../shared/primitives/ids';

/** Input for one committed anchor row. */
export interface LedgerAnchorInput {
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  /** sha256 over the range's `seq:eventHash` lines, in seq order. */
  readonly digest: string;
  readonly anchoredAt: string;
}

/** Scope key naming one warehouse's chain. */
export interface LedgerAnchorScope {
  readonly tenantId: string;
  readonly warehouseId: string;
}

/**
 * The anchor target seam (Story 2.1, AD-16 — the human Option A decision):
 * chain heads anchor to *an* append-only store, declared as this interface
 * so a real external WORM store swaps in later without touching the chain.
 * The Postgres implementation below (`ledger_anchors`, guarded append-only
 * by the migration trigger) is the default target. Both operations run in
 * the CALLER's transaction — the store never opens its own, so an anchor
 * commits (or rolls back) with the chain walk it belongs to.
 */
export interface LedgerAnchorStore {
  /** Commits one anchor row — append-only; anchors are never revised. */
  anchor(input: LedgerAnchorInput, tx: TenantTx): Promise<void>;
  /** The highest anchored seq for the scope, if any, inside `tx`. */
  latest(scope: LedgerAnchorScope, tx: TenantTx): Promise<LedgerAnchor | null>;
}

/** DI token for the anchor store seam. */
export const LEDGER_ANCHOR_STORE = 'LEDGER_ANCHOR_STORE' as const;

/**
 * Postgres anchor store (the default `LedgerAnchorStore` target): appends
 * one `ledger_anchors` row inside the caller's tenant transaction. The
 * table's RLS policy and append-only trigger are declared in migration
 * 0006 only (the established hand-appended DDL pattern).
 */
@Injectable()
export class PostgresLedgerAnchorStore implements LedgerAnchorStore {
  async anchor(input: LedgerAnchorInput, tx: TenantTx): Promise<void> {
    await tx.insert(ledgerAnchors).values({
      id: uuidv7(),
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      fromSeq: input.fromSeq,
      toSeq: input.toSeq,
      digest: input.digest,
      anchoredAt: input.anchoredAt,
    });
  }

  async latest(scope: LedgerAnchorScope, tx: TenantTx): Promise<LedgerAnchor | null> {
    const rows = await tx
      .select()
      .from(ledgerAnchors)
      .where(
        and(
          eq(ledgerAnchors.tenantId, scope.tenantId),
          eq(ledgerAnchors.warehouseId, scope.warehouseId),
        ),
      )
      .orderBy(desc(ledgerAnchors.toSeq))
      .limit(1);
    return rows[0] ?? null;
  }
}
