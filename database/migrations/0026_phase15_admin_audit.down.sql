BEGIN;

DROP INDEX IF EXISTS admin_audit_log_actor_idx;
DROP INDEX IF EXISTS admin_audit_log_target_idx;
DROP TABLE IF EXISTS admin_audit_log;

COMMIT;
