ALTER TABLE "fragment" ADD COLUMN "deadline_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "fragment_queue_idx" ON "fragment" USING btree (("kind" = 'backup') desc,("kind" = 'verification'),"deadline_at","seq") WHERE "fragment"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "fragment_lease_node_idx" ON "fragment" USING btree ("lease_node_id");--> statement-breakpoint
CREATE INDEX "fragment_completed_by_idx" ON "fragment" USING btree ("completed_by_node_id");--> statement-breakpoint
-- Existing pieces take their job's deadline (it never changes after the quote).
UPDATE "fragment" SET "deadline_at" = "job"."deadline_at" FROM "job" WHERE "job"."id" = "fragment"."job_id" AND "fragment"."deadline_at" IS NULL;
