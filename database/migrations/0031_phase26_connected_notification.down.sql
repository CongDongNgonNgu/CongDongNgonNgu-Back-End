-- Roll code back first. Validation refuses rollback while BUDDY_CONNECTED rows
-- remain: keep the additive schema until retention removes them; do not erase data.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (
  notification_type IN ('COMMENT_REPLY','CORRECTION_ACCEPTED','ANSWER_ACCEPTED','BUDDY_REQUEST',
    'ROOM_INVITE','EVENT_REMINDER','REPUTATION_MILESTONE','MEMBERSHIP_STATE','PAYMENT_STATE','MODERATION_NOTICE','SECURITY_NOTICE')
);
