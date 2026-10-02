BEGIN;

DO $$ BEGIN
  CREATE TYPE event_registration_status AS ENUM ('REGISTERED', 'WAITLISTED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE event_invitation_status AS ENUM ('ACTIVE', 'REVOKED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE event_reminder_kind AS ENUM ('TWENTY_FOUR_HOURS', 'ONE_HOUR');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE event_reminder_status AS ENUM ('SCHEDULED', 'SUPPRESSED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE event_attendance_evidence_type AS ENUM ('HOST_MARKED', 'ROOM_PRESENCE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS event_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES community_events(id) ON DELETE CASCADE,
  invited_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  invited_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status event_invitation_status NOT NULL DEFAULT 'ACTIVE',
  invited_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_invitations_unique_user UNIQUE (event_id, invited_user_id),
  CONSTRAINT event_invitations_state_check CHECK (
    (status = 'ACTIVE'::event_invitation_status AND revoked_at IS NULL)
    OR (status = 'REVOKED'::event_invitation_status AND revoked_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS event_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES community_events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status event_registration_status NOT NULL DEFAULT 'REGISTERED',
  waitlist_position integer,
  registered_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_registrations_unique_user UNIQUE (event_id, user_id),
  CONSTRAINT event_registrations_waitlist_check CHECK (
    (status = 'WAITLISTED'::event_registration_status AND waitlist_position >= 1 AND cancelled_at IS NULL)
    OR (status = 'REGISTERED'::event_registration_status AND waitlist_position IS NULL AND cancelled_at IS NULL)
    OR (status = 'CANCELLED'::event_registration_status AND waitlist_position IS NULL AND cancelled_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS event_reminder_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES community_events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  registration_id uuid NOT NULL REFERENCES event_registrations(id) ON DELETE CASCADE,
  kind event_reminder_kind NOT NULL,
  scheduled_for timestamptz NOT NULL,
  recipient_timezone varchar(64) NOT NULL,
  status event_reminder_status NOT NULL,
  suppression_reason varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_reminder_intents_unique_kind UNIQUE (event_id, user_id, kind),
  CONSTRAINT event_reminder_intents_timezone_check CHECK (length(btrim(recipient_timezone)) BETWEEN 1 AND 64),
  CONSTRAINT event_reminder_intents_suppression_check CHECK (
    (status = 'SCHEDULED'::event_reminder_status AND suppression_reason IS NULL)
    OR (status <> 'SCHEDULED'::event_reminder_status AND suppression_reason IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS event_attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES community_events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  evidence_type event_attendance_evidence_type NOT NULL,
  evidence_id varchar(200) NOT NULL,
  marked_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL,
  fingerprint varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_attendance_unique_user UNIQUE (event_id, user_id),
  CONSTRAINT event_attendance_evidence_id_check CHECK (
    evidence_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
  ),
  CONSTRAINT event_attendance_fingerprint_check CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT event_attendance_marker_check CHECK (
    (evidence_type = 'HOST_MARKED'::event_attendance_evidence_type AND marked_by_user_id IS NOT NULL)
    OR (evidence_type = 'ROOM_PRESENCE'::event_attendance_evidence_type AND marked_by_user_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS event_invitations_user_idx
  ON event_invitations (invited_user_id, status, invited_at DESC, event_id);

CREATE INDEX IF NOT EXISTS event_registrations_event_status_idx
  ON event_registrations (event_id, status, registered_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS event_registrations_user_idx
  ON event_registrations (user_id, status, updated_at DESC, event_id);

CREATE INDEX IF NOT EXISTS event_reminder_intents_due_idx
  ON event_reminder_intents (status, scheduled_for ASC, id ASC);

CREATE INDEX IF NOT EXISTS event_attendance_user_idx
  ON event_attendance (user_id, occurred_at DESC, event_id);

-- Event reminders reuse the Phase 12 in-app preference boundary without
-- activating an external delivery provider.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (
  notification_type IN (
    'COMMENT_REPLY',
    'CORRECTION_ACCEPTED',
    'ANSWER_ACCEPTED',
    'BUDDY_REQUEST',
    'ROOM_INVITE',
    'EVENT_REMINDER',
    'REPUTATION_MILESTONE',
    'MEMBERSHIP_STATE',
    'PAYMENT_STATE',
    'MODERATION_NOTICE',
    'SECURITY_NOTICE'
  )
);

COMMIT;
