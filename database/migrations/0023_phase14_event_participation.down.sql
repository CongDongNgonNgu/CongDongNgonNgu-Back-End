BEGIN;

DROP TABLE IF EXISTS event_attendance;
DROP TABLE IF EXISTS event_reminder_intents;
DROP TABLE IF EXISTS event_registrations;
DROP TABLE IF EXISTS event_invitations;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (
  notification_type IN (
    'COMMENT_REPLY',
    'CORRECTION_ACCEPTED',
    'ANSWER_ACCEPTED',
    'BUDDY_REQUEST',
    'ROOM_INVITE',
    'REPUTATION_MILESTONE',
    'MEMBERSHIP_STATE',
    'PAYMENT_STATE',
    'MODERATION_NOTICE',
    'SECURITY_NOTICE'
  )
);

DROP TYPE IF EXISTS event_attendance_evidence_type;
DROP TYPE IF EXISTS event_reminder_status;
DROP TYPE IF EXISTS event_reminder_kind;
DROP TYPE IF EXISTS event_invitation_status;
DROP TYPE IF EXISTS event_registration_status;

COMMIT;
