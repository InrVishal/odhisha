-- Ledgers and the audit log are append-only. Corrections are new rows
-- (entry_type = 'reversal'), never edits. This is enforced in the database so
-- a bug or a compromised app server cannot rewrite history through the ORM.
CREATE OR REPLACE FUNCTION nightshift_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER owner_ledger_append_only BEFORE UPDATE OR DELETE ON owner_ledger
  FOR EACH ROW EXECUTE FUNCTION nightshift_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER owner_ledger_no_truncate BEFORE TRUNCATE ON owner_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION nightshift_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER buyer_ledger_append_only BEFORE UPDATE OR DELETE ON buyer_ledger
  FOR EACH ROW EXECUTE FUNCTION nightshift_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER buyer_ledger_no_truncate BEFORE TRUNCATE ON buyer_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION nightshift_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER credit_ledger_append_only BEFORE UPDATE OR DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION nightshift_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER credit_ledger_no_truncate BEFORE TRUNCATE ON credit_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION nightshift_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION nightshift_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION nightshift_reject_mutation();
