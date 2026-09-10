ALTER TABLE "bins" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bins" ADD COLUMN "retired_by" uuid;--> statement-breakpoint
-- Story 3.6 hand-append (the 0014 release-pairing pattern): a retired bin
-- carries BOTH who retired it and when; a live bin carries neither. The DB
-- backstop behind the retire command's conditional UPDATE.
ALTER TABLE "bins" ADD CONSTRAINT "bins_retired_pairing" CHECK (
	("retired_at" IS NULL AND "retired_by" IS NULL)
	OR ("retired_at" IS NOT NULL AND "retired_by" IS NOT NULL)
);