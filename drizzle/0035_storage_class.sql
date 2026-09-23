ALTER TABLE "bins" ADD COLUMN "storage_class" text DEFAULT 'ambient' NOT NULL;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "storage_class" text DEFAULT 'ambient' NOT NULL;--> statement-breakpoint
-- ── hand-appended: the storage-class CHECKs (the 0034 pattern) ──────────────
-- Story 12-1 (FR-40 / AD-18). `drizzle-kit generate` is blind to CHECKs, so
-- they are migration-SQL-only: the columns above carry no schema-side
-- constraint object and the next generate must not re-emit them. The
-- vocabulary is the tuple in `src/shared/primitives/storage-class.ts` —
-- one source, mirrored by the DTO `@IsIn` and enforced by
-- `assertStorageClass`. NOT NULL DEFAULT, so no null arm. No data statement:
-- every pre-12.1 row is `ambient` by default and a non-conforming state
-- cannot pre-exist because the vocabulary is new.
ALTER TABLE "bins" ADD CONSTRAINT "bins_storage_class_check" CHECK (
  "storage_class" IN ('ambient', 'chilled', 'frozen', 'controlled', 'hazardous', 'secure')
);--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_storage_class_check" CHECK (
  "storage_class" IN ('ambient', 'chilled', 'frozen', 'controlled', 'hazardous', 'secure')
);
