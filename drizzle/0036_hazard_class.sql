ALTER TABLE "skus" ADD COLUMN "hazard_class" text;--> statement-breakpoint
-- ── hand-appended: the hazard-class CHECK (the 0034/0035 pattern) ───────────
-- Story 12-2 (FR-41). `drizzle-kit generate` is blind to CHECKs, so it is
-- migration-SQL-only: the column above carries no schema-side constraint
-- object and the next generate must not re-emit it. The vocabulary is the
-- tuple in `src/shared/primitives/hazard.ts` — one source, mirrored by the
-- DTO `@IsIn` and enforced by `assertHazardClass`. Nullable (no default):
-- null = "not hazardous" and carries NO rule in either direction of the
-- matrix, so the null arm is required. No data statement: no hazard class
-- existed before, so no pre-existing state can violate the CHECK.
ALTER TABLE "skus" ADD CONSTRAINT "skus_hazard_class_check" CHECK (
  "hazard_class" IS NULL OR "hazard_class" IN ('explosive', 'oxidizer', 'flammable', 'corrosive-acid', 'corrosive-base', 'toxic', 'gas')
);