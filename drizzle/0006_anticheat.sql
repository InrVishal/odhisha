CREATE TABLE "benchmark_sample" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"items" integer NOT NULL,
	"millis" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "benchmark_sample_positive" CHECK ("benchmark_sample"."items" > 0 and "benchmark_sample"."millis" > 0)
);
--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "challenge" jsonb;--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "reported_benchmark" integer;--> statement-breakpoint
ALTER TABLE "benchmark_sample" ADD CONSTRAINT "benchmark_sample_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "benchmark_sample_node_idx" ON "benchmark_sample" USING btree ("node_id","created_at");--> statement-breakpoint
-- Scores so far were self-reported by agents. Keep them for display only;
-- the coordinator measures its own from now on.
UPDATE "node" SET "reported_benchmark" = "benchmark_score", "benchmark_score" = NULL;
