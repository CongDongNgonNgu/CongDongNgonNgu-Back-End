-- Disposable TEST/development only. No production rollback authorization.
DROP TABLE IF EXISTS study_group_rate_limits;
DROP TABLE IF EXISTS study_group_reports;
DROP TABLE IF EXISTS study_group_texts;
DROP TABLE IF EXISTS study_group_invitations;
ALTER TABLE IF EXISTS study_groups DROP CONSTRAINT IF EXISTS study_group_current_owner_fk;
DROP TABLE IF EXISTS study_group_memberships;
DROP TABLE IF EXISTS study_groups;
