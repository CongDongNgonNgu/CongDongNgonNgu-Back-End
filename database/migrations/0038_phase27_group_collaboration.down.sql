-- Code-first rollback: refuse active group streams and retained reference loss.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM direct_message_stream_leases WHERE group_id IS NOT NULL AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'PHASE27_ACTIVE_GROUP_STREAMS'; END IF;
 IF EXISTS(SELECT 1 FROM study_group_texts WHERE context_id IS NOT NULL) THEN RAISE EXCEPTION 'PHASE27_RETAINED_CONTEXT_REFERENCES'; END IF;
END $$;
DELETE FROM direct_message_stream_leases WHERE group_id IS NOT NULL AND expires_at<=clock_timestamp();
ALTER TABLE direct_message_stream_leases DROP CONSTRAINT communication_stream_target_xor;
ALTER TABLE direct_message_stream_leases DROP COLUMN group_id;
ALTER TABLE direct_message_stream_leases ALTER COLUMN conversation_id SET NOT NULL;
DROP TRIGGER phase27_group_text_sequence ON study_group_texts; DROP FUNCTION phase27_group_text_sequence();
DROP TRIGGER phase27_group_hide_version ON study_group_texts;
DROP TRIGGER phase27_group_membership_version ON study_group_memberships;
DROP TRIGGER phase27_group_membership_epoch ON study_group_memberships;
DROP FUNCTION phase27_group_hide_version(); DROP FUNCTION phase27_group_membership_version(); DROP FUNCTION phase27_group_membership_epoch();
ALTER TABLE study_group_texts DROP CONSTRAINT study_group_text_positive_sequence;
ALTER TABLE study_group_texts DROP CONSTRAINT study_group_context_check;
ALTER TABLE study_group_texts DROP CONSTRAINT study_group_texts_body_check;
ALTER TABLE study_group_texts ADD CONSTRAINT study_group_texts_body_check CHECK(char_length(body) BETWEEN 1 AND 2000 AND char_length(btrim(body))>0);
DROP INDEX study_group_text_client_idx; DROP INDEX study_group_text_sequence_idx;
ALTER TABLE study_group_texts DROP COLUMN client_message_id,DROP COLUMN context_type,DROP COLUMN context_id,DROP COLUMN sequence;
ALTER TABLE study_group_memberships DROP COLUMN read_sequence,DROP COLUMN generation;
ALTER TABLE study_groups DROP COLUMN text_sequence,DROP COLUMN change_version;
