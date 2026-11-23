CREATE TYPE "public"."cover_status" AS ENUM('waiting', 'passed', 'failed');--> statement-breakpoint
CREATE TABLE "admin_totp" (
	"user_id" text PRIMARY KEY NOT NULL,
	"secret_sealed" text NOT NULL,
	"enabled_at" timestamp with time zone,
	"last_step" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_sent" (
	"audit_id" bigint PRIMARY KEY NOT NULL,
	"status" varchar(16) NOT NULL,
	"attempts" smallint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canary_cover" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"fragment_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"status" "cover_status" DEFAULT 'waiting' NOT NULL,
	"canary_fragment_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "canary_reuse" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Sessions that exist before this migration count as old logins (not "fresh"),
-- so none of them can open the admin pages.
ALTER TABLE "session" ADD COLUMN "created_at" timestamp with time zone DEFAULT '1970-01-01T00:00:00Z' NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "mfa_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_totp" ADD CONSTRAINT "admin_totp_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canary_cover" ADD CONSTRAINT "canary_cover_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canary_cover" ADD CONSTRAINT "canary_cover_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "canary_cover_fragment_uq" ON "canary_cover" USING btree ("fragment_id");--> statement-breakpoint
CREATE INDEX "canary_cover_node_idx" ON "canary_cover" USING btree ("node_id","status");--> statement-breakpoint
CREATE INDEX "fragment_piece_idx" ON "fragment" USING btree ("job_id","seq");--> statement-breakpoint
CREATE INDEX "fragment_parent_idx" ON "fragment" USING btree ("parent_fragment_id");--> statement-breakpoint
CREATE INDEX "fragment_output_digest_idx" ON "fragment" USING btree ("output_digest");
--> statement-breakpoint
-- ─── Database roles ─────────────────────────────────────────────────────────
-- app_runtime: what the web app connects as. Only the tables and actions it
--   needs: no schema changes, no UPDATE/DELETE/TRUNCATE on the ledgers or the
--   audit log, no UPDATE of "user".role, no TEMP tables.
-- readonly: admin reporting only (SELECT on a few tables, no emails, no tokens).
-- The migrator is the role that owns the schema (Neon: neondb_owner). It runs
-- this file, and its password only lives in the deploy step.
-- Both roles are NOLOGIN here. Turning one into a login (with a password) is a
-- deploy step, never a migration: see SECURITY.md, "Database roles".
DO $$
BEGIN
  BEGIN
    CREATE ROLE app_runtime NOLOGIN;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
  BEGIN
    CREATE ROLE readonly NOLOGIN;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
END $$;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()); END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_runtime, readonly;
--> statement-breakpoint
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
--> statement-breakpoint
-- Accounts are never hard-deleted. role, id and created_at can't be updated.
GRANT SELECT, INSERT ON "user" TO app_runtime;
--> statement-breakpoint
GRANT UPDATE (name, email, "emailVerified", image, upi_hash, upi_masked, deleted_at) ON "user" TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON account, "verificationToken" TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON session TO app_runtime;
--> statement-breakpoint
GRANT UPDATE (expires, mfa_at) ON session TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON waitlist TO app_runtime;
--> statement-breakpoint
-- A PC's owner and a job's buyer never change.
GRANT SELECT, INSERT ON node, job TO app_runtime;
--> statement-breakpoint
GRANT UPDATE (name, gpu_class, gpu_model, vram_mb, default_watts, measured_watts, watts_estimated, benchmark_score,
  reported_benchmark, pieces_done, earns_credits, device_hash, subnet_hash, last_canary_at, trust_score, checks_passed,
  checks_failed, status, paused, tariff_paise_per_kwh, owner_rate_paise_per_hr, night_window_start_min,
  night_window_end_min, timezone, last_seen_at, quarantined_at) ON node TO app_runtime;
--> statement-breakpoint
GRANT UPDATE (status, confirmed_at, completed_at, refunded_at, credits_spent, purge_after, purged_at) ON job TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON node_token TO app_runtime;
--> statement-breakpoint
GRANT UPDATE (last_used_at, revoked_at) ON node_token TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON fragment, lock TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON benchmark_sample TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON blob TO app_runtime;
--> statement-breakpoint
-- Append-only: insert and read, nothing else.
GRANT SELECT, INSERT ON owner_ledger, buyer_ledger, credit_ledger, audit_log TO app_runtime;
--> statement-breakpoint
-- The TOTP secret itself can't be changed or read back by anything but the app's own decrypt.
GRANT SELECT, INSERT ON admin_totp TO app_runtime;
--> statement-breakpoint
GRANT UPDATE (enabled_at, last_step) ON admin_totp TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON alert_sent TO app_runtime;
--> statement-breakpoint
GRANT UPDATE (status, attempts) ON alert_sent TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON canary_cover TO app_runtime;
--> statement-breakpoint
GRANT UPDATE (status, canary_fragment_id, settled_at) ON canary_cover TO app_runtime;
--> statement-breakpoint
-- Admin reporting: no emails, no sessions, no tokens, no job data.
GRANT SELECT (id, role, created_at, deleted_at) ON "user" TO readonly;
--> statement-breakpoint
GRANT SELECT ON node, job, owner_ledger, buyer_ledger, credit_ledger, audit_log, canary_cover TO readonly;
--> statement-breakpoint
-- ─── "user".role can only be changed by the owner role ─────────────────────
-- app_runtime can't UPDATE the column at all (no column privilege). This
-- trigger is the second lock, for any role that does have UPDATE or INSERT:
-- a role other than the table's owner (or a member of it) can't set or change
-- role. Its attempt is undone, not raised as an error, so the audit row
-- recording it survives (an error would roll the log back with it). Every
-- change, allowed or refused, is logged; the scheduler emails the admins.
CREATE OR REPLACE FUNCTION nightshift_log_role_attempt(p_user text, p_from text, p_to text, p_by text, p_allowed boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  -- Only from inside the trigger below, so nobody can forge these rows by calling it.
  IF pg_trigger_depth() < 1 THEN
    RAISE EXCEPTION 'nightshift_log_role_attempt is only called by the role trigger' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.audit_log (actor_id, actor_type, action, target_type, target_id, meta)
  VALUES (NULL, 'system', CASE WHEN p_allowed THEN 'admin.role_changed' ELSE 'admin.role_change_refused' END, 'user', p_user,
          jsonb_build_object('from', p_from, 'to', p_to, 'dbRole', p_by));
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nightshift_guard_role() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  table_owner name;
  allowed boolean;
  before_role text := CASE WHEN TG_OP = 'UPDATE' THEN OLD.role::text ELSE 'user' END;
BEGIN
  IF NEW.role::text = before_role THEN
    RETURN NEW;
  END IF;
  SELECT pg_get_userbyid(c.relowner) INTO table_owner FROM pg_class c WHERE c.oid = TG_RELID;
  allowed := pg_has_role(current_user, table_owner, 'MEMBER')
    OR EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = current_user AND r.rolsuper);
  PERFORM nightshift_log_role_attempt(NEW.id, before_role, NEW.role::text, current_user::text, allowed);
  IF NOT allowed THEN
    NEW.role := before_role::user_role;
    RAISE WARNING 'role change refused for database role %', current_user;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER user_role_guard BEFORE INSERT OR UPDATE OF role ON "user"
  FOR EACH ROW EXECUTE FUNCTION nightshift_guard_role();
--> statement-breakpoint
-- A confirmed second factor can't be switched off by the app; the owner role
-- resets it by deleting the row.
CREATE OR REPLACE FUNCTION nightshift_guard_totp() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.enabled_at IS NOT NULL AND NEW.enabled_at IS DISTINCT FROM OLD.enabled_at THEN
    RAISE EXCEPTION 'a confirmed second factor can only be reset by the owner role' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER admin_totp_guard BEFORE UPDATE ON admin_totp
  FOR EACH ROW EXECUTE FUNCTION nightshift_guard_totp();
