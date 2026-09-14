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
-- The arm IS status-aware, unlike the two above it: a `planned` slice must
-- never record a shortfall it has not experienced — that is a stop the floor
-- is still walking to, and a shortfall on it would be a claim about a bin
-- nobody has opened. `cancelled` rides along for the reason 0018 gives about
-- keying on `bin_id`: cancelling a wave flips lines to `cancelled`, and a
-- withdrawn line keeps whatever shape it had rather than being rewritten.
ALTER TABLE "picklist_lines" DROP CONSTRAINT "picklist_lines_slice_shape";--> statement-breakpoint
ALTER TABLE "picklist_lines" ADD CONSTRAINT "picklist_lines_slice_shape" CHECK (
	("bin_id" IS NULL AND "qty" = 0 AND "shortfall_qty" > 0)
	OR ("bin_id" IS NOT NULL AND "qty" > 0 AND "shortfall_qty" = 0)
	OR (
		"status" IN ('short','cancelled')
		AND "bin_id" IS NOT NULL AND "qty" > 0
		AND "shortfall_qty" > 0 AND "shortfall_qty" <= "qty"
	)
);--> statement-breakpoint
-- A short line is USELESS to SM-3 without both halves of what it reports: how
-- many units never moved, and why. The command already refuses a reason-less
-- short pick with a 400; this is the backstop that keeps a direct writer (or
-- a future command) from recording the row SM-3 cannot aggregate.
ALTER TABLE "picklist_lines" ADD CONSTRAINT "picklist_lines_short_pairing" CHECK (
	"status" <> 'short' OR ("shortfall_qty" > 0 AND "reason_code" IS NOT NULL)
);--> statement-breakpoint
-- …and the reason belongs ONLY to a short line (or to one withdrawn by a wave
-- cancel, which keeps its record). A reason on a `planned` or `picked` line
-- would be an explanation of something that did not happen.
--
-- The value itself is a FIXED enum (the 0013 `blind_reason_code` precedent):
-- the command answers 400 naming the whole set, and the database is the
-- backstop that keeps a writer from inventing an arm no report knows about.
ALTER TABLE "picklist_lines" ADD CONSTRAINT "picklist_lines_reason_code_check" CHECK (
	"reason_code" IS NULL
	OR (
		"status" IN ('short','cancelled')
		AND "reason_code" IN ('bin-empty','fewer-units-than-planned','damaged-units','stock-not-found','other')
	)
);
