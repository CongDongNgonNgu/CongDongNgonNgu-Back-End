-- Current pair-authorized, generic direct-message navigation only.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (
  notification_type IN ('COMMENT_REPLY','CORRECTION_ACCEPTED','ANSWER_ACCEPTED','BUDDY_REQUEST',
    'BUDDY_CONNECTED','DIRECT_MESSAGE','ROOM_INVITE','EVENT_REMINDER','REPUTATION_MILESTONE',
    'MEMBERSHIP_STATE','PAYMENT_STATE','MODERATION_NOTICE','SECURITY_NOTICE')
);

-- Retain monotonic generations. Deleting/creating an intent would allow an old
-- completion to acknowledge a newer send whose generation restarted at one.
ALTER TABLE direct_message_notification_intents
  ADD COLUMN processed_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD CONSTRAINT direct_message_notification_progress_check CHECK (
    processed_generation >= 0 AND processed_generation <= generation),
  ADD CONSTRAINT direct_message_notification_attempts_check CHECK (attempts BETWEEN 0 AND 16);

CREATE INDEX direct_message_notification_due_idx
  ON direct_message_notification_intents(available_at,updated_at,conversation_id,recipient_user_id)
  WHERE processed_generation < generation;
