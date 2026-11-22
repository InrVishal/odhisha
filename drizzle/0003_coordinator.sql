CREATE TABLE "blob" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"data" "bytea" NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lock" (
	"name" varchar(64) PRIMARY KEY NOT NULL,
	"locked_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fragment" ADD COLUMN "item_count" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "fragment" ADD COLUMN "input_sha256" varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE "fragment" ADD COLUMN "lease_expected_sec" integer;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "gpu_class" "gpu_class" NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "item_count" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "max_watt_tariff" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "max_owner_rate" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "blob" ADD CONSTRAINT "blob_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blob_job_idx" ON "blob" USING btree ("job_id");--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_items_positive" CHECK ("job"."item_count" > 0);