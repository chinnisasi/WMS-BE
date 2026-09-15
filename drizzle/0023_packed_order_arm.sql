-- Story 4.5 hand-append (the 0019/0022 CHECK pattern): CHECKs are declared
-- only in migration SQL, never in schema.ts.
--
-- The ORDER state machine gains its first new arm since 4.1:
-- `ready_to_dispatch`. A packed order has been verified at the bench against
-- what was actually picked, has one zero-quantity `pack.packed` ledger event
-- per order line, and is waiting for 4.6 to rate, label and dispatch it.
--
-- The arm is TERMINAL for every pre-dispatch flow: 4.1's cancel refuses it
-- (a packed order's units have left their bins), both of 4.2's wave-selection
-- paths already exclude anything that is not `accepted`, and 4.3's queued
-- pick quarantines against it. An order reaches Ready-to-Dispatch once — the
-- pack command's conditional flip keys on `status = 'accepted'`, so a second
-- pack under a new key finds nothing to flip and is refused before it writes.
--
-- Drop-then-re-add with the widened set is the additive precedent 0019 and
-- 0022 set for `picklist_lines_status_check`; the command-layer constant
-- `ORDER_STATUSES` mirrors it and `orders.spec.ts` pins the two together.
ALTER TABLE "orders" DROP CONSTRAINT "orders_status_check";--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_check" CHECK ("status" IN ('accepted','ready_to_dispatch','cancelled'));
