/**
 * The closed adjustment reason vocabulary (story 5-2, human-approved
 * 2026-09-28): eight machine reasons replace the free-form 1–64 text the
 * `StockAdjustmentDto.reasonCode` field used to accept. A closed list is a
 * fail-closed guard — every spelling nobody thought of is refused at the DTO
 * rather than silently accepted (the controlled-vocabulary rule, guide §4).
 *
 * Consumption map (what reads this constant, honestly):
 * - **API layer** — `inventory.dto.ts` `@IsIn(ADJUSTMENT_REASON_CODES)` over
 *   THIS tuple, the third mirrored layer's TS side.
 * - **DB** — the `stock_adjustment_pendings_reason_code_check` CHECK in
 *   migration 0044 enumerates the same eight values (CHECKs live only in
 *   migration SQL); `test/adjustment-approval.spec.ts` pins the TS list
 *   against the DB constraint so the two copies cannot drift silently.
 * - **NOT the command layer** — `inventory.command.ts` imports neither this
 *   constant nor any `other`-requires-note guard. The DTO already requires a
 *   non-empty note (1–500 chars) on EVERY adjustment, so the `other` arm's
 *   note requirement is satisfied by that same required field — there is no
 *   separate command-tier check, and this file deliberately adds none.
 *
 * Historical rows are unaffected: the ledger `referenceDoc.reasonCode` of an
 * event written before this vocabulary is free-form text and still reads back
 * verbatim on the timeline (the passthrough is untyped); only NEW writes are
 * constrained. Legacy reason codes in ~20 suites' seeded bodies are migrated
 * with the vocabulary (the suites' `cycle-count` fixtures became `stock-count`).
 */
export const ADJUSTMENT_REASON_CODES = [
  'stock-count',
  'damaged',
  'expired',
  'shrinkage',
  'found',
  'recall',
  'system-correction',
  'other',
] as const;

export type AdjustmentReasonCode = (typeof ADJUSTMENT_REASON_CODES)[number];