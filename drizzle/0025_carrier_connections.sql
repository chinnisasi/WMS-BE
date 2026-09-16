CREATE TABLE "carrier_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"carrier_code" text NOT NULL,
	"account_label" text NOT NULL,
	"credential_sealed" text NOT NULL,
	"credential_version" integer DEFAULT 1 NOT NULL,
	"connected_by" uuid NOT NULL,
	"rotated_at" timestamp with time zone,
	"rotated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "carrier_connections_tenant_carrier_unique" ON "carrier_connections" USING btree ("tenant_id","carrier_code");--> statement-breakpoint
CREATE INDEX "carrier_connections_tenant_created_at_id_idx" ON "carrier_connections" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
-- Story 4.6b hand-append (the 0006-0010/0019/0021 RLS + CHECK pattern): RLS
-- and CHECKs are declared only in migration SQL, never in schema.ts
-- (drizzle-orm 0.45 cannot model either without making future `generate` runs
-- emit conflicting DDL against this hand-written half).
--
-- The same fail-closed single-dimension `tenant_isolation` policy every
-- tenant-scoped table carries. The `NULLIF(current_setting(..., true), '')`
-- guard is load-bearing: Postgres returns '' once a transaction-local value
-- expires, so an un-scoped session sees ZERO rows instead of erroring — and
-- on THIS table a fail-open would expose sealed carrier credentials across
-- tenants.
ALTER TABLE "carrier_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "carrier_connections_tenant_isolation" ON "carrier_connections"
	USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
	WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- The credential column holds an ENVELOPE BLOB, never plaintext: every value
-- the command writes comes out of `seal()`, whose format is
-- `v1:<iv b64>:<auth tag b64>:<ciphertext b64>`. The CHECK is the DB-side
-- backstop for the story's one invariant — a code path that ever tried to
-- store raw credential material fails the write instead of silently keeping
-- a secret in the clear.
ALTER TABLE "carrier_connections" ADD CONSTRAINT "carrier_connections_credential_sealed_envelope" CHECK ("credential_sealed" LIKE 'v1:%');--> statement-breakpoint
-- The material's generation counter: 1 at connect, +1 per rotation. Never
-- zero, never negative, and it only ever moves forward (rotation is the only
-- writer).
ALTER TABLE "carrier_connections" ADD CONSTRAINT "carrier_connections_credential_version_positive" CHECK ("credential_version" > 0);--> statement-breakpoint
-- A connection an operator cannot tell apart from another is unmanageable:
-- the account label is required and non-blank (the command rejects blanks
-- with a 400 first; this is the backstop).
ALTER TABLE "carrier_connections" ADD CONSTRAINT "carrier_connections_account_label_nonblank" CHECK (length(btrim("account_label")) > 0);--> statement-breakpoint
-- `rotated_at` and `rotated_by` are stamped together or not at all — a row
-- that knows WHEN it rotated but not BY WHOM (or the reverse) is an audit
-- gap in exactly the record AD-15 makes first-class.
ALTER TABLE "carrier_connections" ADD CONSTRAINT "carrier_connections_rotation_stamp_paired" CHECK (("rotated_at" IS NULL) = ("rotated_by" IS NULL));
