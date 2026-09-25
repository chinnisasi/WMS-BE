-- ── hand-appended: the location-type CHECK (the 0035 pattern) ───────────────
-- Story 12-4 (AD-18). `drizzle-kit generate` is blind to CHECKs, so this is
-- migration-SQL-only: `bins.type` carries no schema-side constraint object
-- and the next generate must not re-emit it. The vocabulary is the tuple in
-- `src/shared/primitives/location-type.ts` — one source, mirrored by the DTO
-- `@IsIn` (via the `BIN_TYPES` re-export in `tenancy.dto.ts`) and enforced by
-- the placement/merge/suggestion gates. Additive only; no column change.
-- No data statement: the four pre-existing types (shelf, pallet, floor,
-- staging) come first in the tuple unchanged, so every pre-12.4 row
-- conforms with zero data mutation.
ALTER TABLE "bins" ADD CONSTRAINT "bins_type_check" CHECK (
  "type" IN ('shelf', 'pallet', 'floor', 'staging', 'floor-stack', 'yard', 'tank', 'silo')
);
