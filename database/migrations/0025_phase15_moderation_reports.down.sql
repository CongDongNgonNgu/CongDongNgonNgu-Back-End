BEGIN;

DROP INDEX IF EXISTS community_report_notes_report_idx;
DROP INDEX IF EXISTS community_reports_assigned_state_idx;
DROP TABLE IF EXISTS community_report_notes;
ALTER TABLE community_reports DROP COLUMN IF EXISTS resolution_reason;
ALTER TABLE community_reports DROP COLUMN IF EXISTS assigned_to_user_id;

COMMIT;
