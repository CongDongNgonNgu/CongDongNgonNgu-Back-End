DO $$ BEGIN
  CREATE TYPE speaking_room_queue_state AS ENUM ('WAITING', 'ACCEPTED', 'DECLINED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE speaking_room_queue_action AS ENUM ('RAISE_HAND', 'CANCEL_HAND', 'ACCEPT', 'DECLINE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE speaking_room_moderation_action AS ENUM (
    'MUTE', 'UNMUTE', 'REMOVE', 'PROMOTE', 'DEMOTE',
    'ACCEPT_QUEUE', 'DECLINE_QUEUE', 'BLOCK', 'UNBLOCK', 'REPORT'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE speaking_room_report_category AS ENUM (
    'SPAM', 'HARASSMENT', 'INAPPROPRIATE_CONTENT', 'SAFETY_CONCERN', 'OTHER'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE speaking_room_report_state AS ENUM ('OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS speaking_room_queue_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES speaking_rooms(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES speaking_room_participants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  state speaking_room_queue_state NOT NULL DEFAULT 'WAITING',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT speaking_room_queue_entry_decision_check CHECK (
    (state = 'WAITING'::speaking_room_queue_state AND decided_at IS NULL AND decided_by_user_id IS NULL)
    OR (state = 'CANCELLED'::speaking_room_queue_state)
    OR (state IN ('ACCEPTED'::speaking_room_queue_state, 'DECLINED'::speaking_room_queue_state)
      AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS speaking_room_queue_waiting_participant_idx
  ON speaking_room_queue_entries (room_id, participant_id)
  WHERE state = 'WAITING'::speaking_room_queue_state;

CREATE INDEX IF NOT EXISTS speaking_room_queue_order_idx
  ON speaking_room_queue_entries (room_id, state, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS speaking_room_queue_actions (
  room_id uuid NOT NULL REFERENCES speaking_rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  queue_entry_id uuid NOT NULL REFERENCES speaking_room_queue_entries(id) ON DELETE CASCADE,
  action_type speaking_room_queue_action NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id, request_id)
);

CREATE INDEX IF NOT EXISTS speaking_room_queue_actions_entry_idx
  ON speaking_room_queue_actions (queue_entry_id, created_at DESC);

CREATE TABLE IF NOT EXISTS speaking_room_moderation_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES speaking_rooms(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_participant_id uuid NOT NULL REFERENCES speaking_room_participants(id) ON DELETE CASCADE,
  target_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action_type speaking_room_moderation_action NOT NULL,
  reason varchar(1000),
  request_id uuid NOT NULL,
  result_duplicate boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT speaking_room_moderation_reason_check CHECK (
    reason IS NULL OR (char_length(reason) BETWEEN 1 AND 1000 AND length(btrim(reason)) > 0)
  ),
  UNIQUE (room_id, actor_user_id, request_id)
);

CREATE INDEX IF NOT EXISTS speaking_room_moderation_actions_room_idx
  ON speaking_room_moderation_actions (room_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS speaking_room_participant_moderation_state (
  participant_id uuid PRIMARY KEY REFERENCES speaking_room_participants(id) ON DELETE CASCADE,
  muted_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT speaking_room_participant_mute_state_check CHECK (muted_until IS NULL OR muted_until > updated_at)
);

CREATE TABLE IF NOT EXISTS speaking_room_participant_blocks (
  room_id uuid NOT NULL REFERENCES speaking_rooms(id) ON DELETE CASCADE,
  blocker_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, blocker_user_id, blocked_user_id),
  UNIQUE (room_id, blocker_user_id, request_id),
  CONSTRAINT speaking_room_participant_block_actor_check CHECK (blocker_user_id <> blocked_user_id)
);

CREATE INDEX IF NOT EXISTS speaking_room_participant_blocks_blocked_idx
  ON speaking_room_participant_blocks (room_id, blocked_user_id, blocker_user_id);

CREATE TABLE IF NOT EXISTS speaking_room_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES speaking_rooms(id) ON DELETE CASCADE,
  reporter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_participant_id uuid NOT NULL REFERENCES speaking_room_participants(id) ON DELETE CASCADE,
  target_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  category speaking_room_report_category NOT NULL,
  details varchar(1000),
  state speaking_room_report_state NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT speaking_room_report_actor_check CHECK (reporter_user_id <> target_user_id),
  CONSTRAINT speaking_room_report_details_check CHECK (
    details IS NULL OR (char_length(details) BETWEEN 1 AND 1000 AND length(btrim(details)) > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS speaking_room_reports_unique_category_idx
  ON speaking_room_reports (room_id, reporter_user_id, target_participant_id, category)
  WHERE state = 'OPEN'::speaking_room_report_state;

CREATE INDEX IF NOT EXISTS speaking_room_reports_target_idx
  ON speaking_room_reports (room_id, target_user_id, state, created_at DESC);

CREATE TABLE IF NOT EXISTS speaking_room_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES speaking_rooms(id) ON DELETE CASCADE,
  author_participant_id uuid NOT NULL REFERENCES speaking_room_participants(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  body varchar(1000) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT speaking_room_chat_body_check CHECK (char_length(btrim(body)) BETWEEN 1 AND 1000),
  UNIQUE (room_id, author_user_id, request_id)
);

CREATE INDEX IF NOT EXISTS speaking_room_chat_room_order_idx
  ON speaking_room_chat_messages (room_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS speaking_room_chat_author_window_idx
  ON speaking_room_chat_messages (room_id, author_user_id, created_at DESC);
