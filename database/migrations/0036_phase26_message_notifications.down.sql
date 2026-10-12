-- Stop incompatible producers/workers first. Do not erase retained notices or
-- pending durable work merely to force a downgrade.
LOCK TABLE notifications, direct_message_notification_intents IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM notifications WHERE notification_type='DIRECT_MESSAGE')
    OR EXISTS (SELECT 1 FROM direct_message_notification_intents WHERE processed_generation < generation) THEN
    RAISE EXCEPTION 'Retained direct-message notices or pending intents prevent downgrade' USING ERRCODE='P0001';
  END IF;
END $$;

DROP INDEX direct_message_notification_due_idx;
ALTER TABLE direct_message_notification_intents
  DROP CONSTRAINT direct_message_notification_progress_check,
  DROP CONSTRAINT direct_message_notification_attempts_check,
  DROP COLUMN processed_generation, DROP COLUMN attempts, DROP COLUMN available_at;
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (
  notification_type IN ('COMMENT_REPLY','CORRECTION_ACCEPTED','ANSWER_ACCEPTED','BUDDY_REQUEST',
    'BUDDY_CONNECTED','ROOM_INVITE','EVENT_REMINDER','REPUTATION_MILESTONE',
    'MEMBERSHIP_STATE','PAYMENT_STATE','MODERATION_NOTICE','SECURITY_NOTICE')
);
