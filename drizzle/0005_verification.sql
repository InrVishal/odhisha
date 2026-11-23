CREATE TYPE "public"."check_verdict" AS ENUM('match', 'mismatch', 'corrected', 'inconclusive');--> statement-breakpoint
ALTER TABLE "fragment" ADD COLUMN "verify" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fragment" ADD COLUMN "verdict" "check_verdict";--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "checks_passed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "checks_failed" integer DEFAULT 0 NOT NULL;