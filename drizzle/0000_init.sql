CREATE TYPE "public"."actor_type" AS ENUM('user', 'admin', 'node', 'system');--> statement-breakpoint
CREATE TYPE "public"."buyer_entry_type" AS ENUM('charge', 'refund');--> statement-breakpoint
CREATE TYPE "public"."credit_entry_type" AS ENUM('earned', 'spent', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."fragment_kind" AS ENUM('primary', 'verification', 'backup');--> statement-breakpoint
CREATE TYPE "public"."fragment_status" AS ENUM('pending', 'leased', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."gpu_class" AS ENUM('rtx3060', 'rtx4070', 'rtx4090', 'cpu');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('quoted', 'queued', 'running', 'completed', 'deadline_missed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."node_status" AS ENUM('pending', 'online', 'offline', 'quarantined', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."owner_entry_type" AS ENUM('power_reimbursement', 'compute_pay', 'payout', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."waitlist_interest" AS ENUM('owner', 'buyer', 'both');--> statement-breakpoint
CREATE TYPE "public"."workload_type" AS ENUM('text_embeddings', 'image_captioning', 'image_resize');--> statement-breakpoint
CREATE TABLE "account" (
	"userId" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "account_provider_providerAccountId_pk" PRIMARY KEY("provider","providerAccountId")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text,
	"actor_type" "actor_type" NOT NULL,
	"action" varchar(64) NOT NULL,
	"target_type" varchar(32),
	"target_id" text,
	"ip_hash" varchar(64),
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE "buyer_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"buyer_id" text NOT NULL,
	"job_id" uuid,
	"entry_type" "buyer_entry_type" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"memo" varchar(256),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buyer_ledger_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"node_id" uuid,
	"job_id" uuid,
	"entry_type" "credit_entry_type" NOT NULL,
	"amount_gpu_seconds" bigint NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"memo" varchar(256),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_ledger_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "fragment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" "fragment_kind" DEFAULT 'primary' NOT NULL,
	"parent_fragment_id" uuid,
	"status" "fragment_status" DEFAULT 'pending' NOT NULL,
	"est_gpu_seconds" integer NOT NULL,
	"input_key" varchar(128) NOT NULL,
	"output_key" varchar(128),
	"output_digest" varchar(64),
	"wrapped_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"lease_node_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"completed_by_node_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fragment_attempts_range" CHECK ("fragment"."attempts" >= 0 and "fragment"."attempts" <= "fragment"."max_attempts"),
	CONSTRAINT "fragment_est_positive" CHECK ("fragment"."est_gpu_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"buyer_id" text NOT NULL,
	"workload_type" "workload_type" NOT NULL,
	"params" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'quoted' NOT NULL,
	"price_paise" bigint NOT NULL,
	"breakdown" jsonb NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"quote_expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"fragment_count" integer DEFAULT 0 NOT NULL,
	"purge_after" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_price_nonnegative" CHECK ("job"."price_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "node_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "node_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "node" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" varchar(64) NOT NULL,
	"gpu_class" "gpu_class" NOT NULL,
	"gpu_model" varchar(128),
	"vram_mb" integer,
	"default_watts" integer NOT NULL,
	"measured_watts" integer,
	"benchmark_score" integer,
	"trust_score" integer DEFAULT 500 NOT NULL,
	"status" "node_status" DEFAULT 'pending' NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"tariff_paise_per_kwh" integer DEFAULT 900 NOT NULL,
	"owner_rate_paise_per_hr" integer NOT NULL,
	"night_window_start_min" smallint DEFAULT 1380 NOT NULL,
	"night_window_end_min" smallint DEFAULT 420 NOT NULL,
	"timezone" varchar(64) DEFAULT 'Asia/Kolkata' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"quarantined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_trust_range" CHECK ("node"."trust_score" between 0 and 1000),
	CONSTRAINT "node_tariff_positive" CHECK ("node"."tariff_paise_per_kwh" > 0),
	CONSTRAINT "node_rate_nonnegative" CHECK ("node"."owner_rate_paise_per_hr" >= 0),
	CONSTRAINT "node_watts_positive" CHECK ("node"."default_watts" > 0 and ("node"."measured_watts" is null or "node"."measured_watts" > 0)),
	CONSTRAINT "node_window_range" CHECK ("node"."night_window_start_min" between 0 and 1439 and "node"."night_window_end_min" between 0 and 1439)
);
--> statement-breakpoint
CREATE TABLE "owner_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"node_id" uuid,
	"job_id" uuid,
	"fragment_id" uuid,
	"entry_type" "owner_entry_type" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"memo" varchar(256),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_ledger_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"sessionToken" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"expires" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"emailVerified" timestamp,
	"image" text,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verificationToken" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp NOT NULL,
	CONSTRAINT "verificationToken_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "waitlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(254) NOT NULL,
	"interest" "waitlist_interest" NOT NULL,
	"consent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_ledger" ADD CONSTRAINT "buyer_ledger_buyer_id_user_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_ledger" ADD CONSTRAINT "buyer_ledger_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fragment" ADD CONSTRAINT "fragment_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fragment" ADD CONSTRAINT "fragment_lease_node_id_node_id_fk" FOREIGN KEY ("lease_node_id") REFERENCES "public"."node"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fragment" ADD CONSTRAINT "fragment_completed_by_node_id_node_id_fk" FOREIGN KEY ("completed_by_node_id") REFERENCES "public"."node"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_buyer_id_user_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_token" ADD CONSTRAINT "node_token_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node" ADD CONSTRAINT "node_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_ledger" ADD CONSTRAINT "owner_ledger_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_ledger" ADD CONSTRAINT "owner_ledger_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_ledger" ADD CONSTRAINT "owner_ledger_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_id","at");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_log" USING btree ("action","at");--> statement-breakpoint
CREATE INDEX "buyer_ledger_buyer_idx" ON "buyer_ledger" USING btree ("buyer_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_ledger_user_idx" ON "credit_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "fragment_job_idx" ON "fragment" USING btree ("job_id","status");--> statement-breakpoint
CREATE INDEX "fragment_lease_idx" ON "fragment" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fragment_primary_seq_uq" ON "fragment" USING btree ("job_id","seq") WHERE "fragment"."kind" = 'primary';--> statement-breakpoint
CREATE INDEX "job_buyer_idx" ON "job" USING btree ("buyer_id");--> statement-breakpoint
CREATE INDEX "job_status_deadline_idx" ON "job" USING btree ("status","deadline_at");--> statement-breakpoint
CREATE INDEX "node_token_node_idx" ON "node_token" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "node_owner_idx" ON "node" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "node_status_idx" ON "node" USING btree ("status");--> statement-breakpoint
CREATE INDEX "owner_ledger_owner_idx" ON "owner_ledger" USING btree ("owner_id","created_at");