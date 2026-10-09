-- Preserve every previously accepted type; add only connection acceptance.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (
  notification_type IN ('COMMENT_REPLY','CORRECTION_ACCEPTED','ANSWER_ACCEPTED','BUDDY_REQUEST',
    'BUDDY_CONNECTED','ROOM_INVITE','EVENT_REMINDER','REPUTATION_MILESTONE','MEMBERSHIP_STATE','PAYMENT_STATE',
    'MODERATION_NOTICE','SECURITY_NOTICE')
);
