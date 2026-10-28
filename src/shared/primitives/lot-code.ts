import { sql } from 'drizzle-orm';

/**
 * Story 3-7a (A9) — the NORMALISED lot code a recall's candidates read
 * matches on: letters and digits only, upper-cased, so `ab-12/3`, `AB 123`
 * and `AB123` are one lot code to a brand reading a label aloud.
 *
 * `LOT_CODE_NORM_SQL` is the ONE expression: the `batches_tenant_code_norm_idx`
 * expression index (schema.ts, 0101) is built over it, and the candidates
 * query (`catalog.facade.ts` `batchesByNormalisedCodeInTx`) states it
 * verbatim, so the planner can use the index (pinned by an EXPLAIN in
 * `test/recalls.spec.ts`). It names the bare `"code"` column — use it only
 * where `batches` is the sole relation in scope.
 */
export const LOT_CODE_NORM_SQL = sql`upper(regexp_replace("code", '[^A-Za-z0-9]', '', 'g'))`;

/** The same normalisation applied to a bound input value, in SQL. */
export function lotCodeNormOf(value: string) {
  return sql`upper(regexp_replace(${value}::text, '[^A-Za-z0-9]', '', 'g'))`;
}

/** The JS twin (shape checks only — the match itself runs in SQL). */
export function normaliseLotCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}
