ALTER TYPE "public"."credit_entry_type" ADD VALUE 'clawback';--> statement-breakpoint
ALTER TYPE "public"."credit_entry_type" ADD VALUE 'expired';--> statement-breakpoint
ALTER TYPE "public"."credit_entry_type" ADD VALUE 'refund';--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "fragment_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "grant_id" bigint;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fragment" ADD COLUMN "canary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "credits_spent" bigint;--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "pieces_done" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "earns_credits" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "device_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "subnet_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "last_canary_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "upi_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "upi_masked" varchar(80);--> statement-breakpoint
CREATE INDEX "credit_ledger_grant_idx" ON "credit_ledger" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "credit_ledger_fragment_idx" ON "credit_ledger" USING btree ("fragment_id");--> statement-breakpoint
CREATE INDEX "node_device_idx" ON "node" USING btree ("device_hash");--> statement-breakpoint
CREATE INDEX "node_subnet_idx" ON "node" USING btree ("subnet_hash");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_upi_hash_unique" UNIQUE("upi_hash");