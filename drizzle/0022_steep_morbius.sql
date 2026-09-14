ALTER TABLE "picklist_lines" ADD COLUMN "reason_code" text;--> statement-breakpoint
-- Story 4.4 hand-append (the 0019/0021 CHECK pattern): CHECKs are declared
-- only in migration SQL, never in schema.ts.
--
-- The line status machine gains `short` — a stop the operator drew fewer
-- units from than it planned, with the reason on the row. `short` is
-- TERMINAL (the remainder lives on a new slice, never on this one) and, like
-- `picked`, it sits OUTSIDE `'cancelled'` so the line keeps its claim in
-- `picklist_lines_open_order_line_unique`: dropping out would free the order
-- line to be re-waved mid-pick, and the second wave would plan units that
-- have already left the bin.
ALTER TABLE "picklist_lines" DROP CONSTRAINT "picklist_lines_status_check";--> statement-breakpoint
ALTER TABLE "picklist_lines" ADD CONSTRAINT "picklist_lines_status_check" CHECK ("status" IN ('planned','unfulfillable','picked','short','cancelled'));--> statement-breakpoint
-- The slice shape gains its third arm. 0018's two arms are "a bin-less slice
-- names a shortfall and no units" and "a binned slice names units and no
-- shortfall"; a short pick is the third real shape — a binned slice that
-- names BOTH, where `qty` stays the planned quantity and `shortfall_qty`
-- records what never moved (so `qty - shortfall_qty` is what did, and a
-- zero-unit short pick is `shortfall_qty = qty`).
--
-- The arm keys on the QUANTITIES, not on `status`, for the same reason 0018
-- gives: cancelling a wave flips every line to `cancelled` — that flip is
-- what frees its orders through the partial unique index — and a short line
-- must survive it exactly as an unfulfillable one does.
ALTER TABLE "picklist_lines" DROP CONSTRAINT "picklist_lines_slice_shape";--> statement-breakpoint
ALTER TABLE "picklist_lines" ADD CONSTRAINT "picklist_lines_slice_shape" CHECK (
	("bin_id" IS NULL AND "qty" = 0 AND "shortfall_qty" > 0)
	OR ("bin_id" IS NOT NULL AND "qty" > 0 AND "shortfall_qty" = 0)
	OR ("bin_id" IS NOT NULL AND "qty" > 0 AND "shortfall_qty" > 0 AND "shortfall_qty" <= "qty")
);--> statement-breakpoint
-- The reason is a FIXED enum (the 0013 `blind_reason_code` precedent): the
-- command answers 400 naming the whole set, and the database is the backstop
-- that keeps a direct writer from inventing an arm no report knows about.
ALTER TABLE "picklist_lines" ADD CONSTRAINT "picklist_lines_reason_code_check" CHECK (
	"reason_code" IS NULL
	OR "reason_code" IN ('bin-empty','fewer-units-than-planned','damaged-units','stock-not-found','other')
);
