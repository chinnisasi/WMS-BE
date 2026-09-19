ALTER TABLE "orders" ADD COLUMN "destination_contact_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "destination_phone" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "destination_line1" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "destination_line2" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "destination_city" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "destination_state" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "destination_pincode" text;--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "origin_contact_name" text;--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "origin_phone" text;--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "origin_line1" text;--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "origin_line2" text;--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "origin_city" text;--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "origin_state" text;--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "origin_pincode" text;
