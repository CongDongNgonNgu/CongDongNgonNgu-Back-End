DO $$ BEGIN
  CREATE TYPE speaking_room_participant_role AS ENUM ('LISTENER', 'SPEAKER', 'HOST', 'MODERATOR');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE speaking_room_participant_state AS ENUM ('PRESENT', 'DISCONNECTED', 'LEFT', 'REMOVED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE speaking_room_participant_action AS ENUM ('JOIN', 'HEARTBEAT', 'LEAVE', 'DISCONNECT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS speaking_room_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES speaking_rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  device_id varchar(128) NOT NULL,
  join_request_id uuid NOT NULL,
  role speaking_room_participant_role NOT NULL,
  state speaking_room_participant_state NOT NULL DEFAULT 'PRESENT',
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz,
  left_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT speaking_room_participant_device_check CHECK (
    length(btrim(device_id)) BETWEEN 1 AND 128
  ),
  CONSTRAINT speaking_room_participant_timestamps_check CHECK (
    (state = 'PRESENT'::speaking_room_participant_state AND left_at IS NULL)
    OR (state = 'DISCONNECTED'::speaking_room_participant_state AND left_at IS NULL)
    OR (state IN ('LEFT'::speaking_room_participant_state, 'REMOVED'::speaking_room_participant_state) AND left_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS speaking_room_participants_join_request_idx
  ON speaking_room_participants (room_id, user_id, join_request_id);

CREATE UNIQUE INDEX IF NOT EXISTS speaking_room_participants_active_device_idx
  ON speaking_room_participants (room_id, user_id, device_id)
  WHERE state IN ('PRESENT'::speaking_room_participant_state, 'DISCONNECTED'::speaking_room_participant_state);

CREATE INDEX IF NOT EXISTS speaking_room_participants_room_state_idx
  ON speaking_room_participants (room_id, state, joined_at, id);

CREATE INDEX IF NOT EXISTS speaking_room_participants_user_idx
  ON speaking_room_participants (user_id, room_id, state);

CREATE TABLE IF NOT EXISTS speaking_room_participant_actions (
  room_id uuid NOT NULL REFERENCES speaking_rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  participant_id uuid NOT NULL REFERENCES speaking_room_participants(id) ON DELETE CASCADE,
  action_type speaking_room_participant_action NOT NULL,
  result_state speaking_room_participant_state NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id, request_id)
);

CREATE INDEX IF NOT EXISTS speaking_room_participant_actions_participant_idx
  ON speaking_room_participant_actions (participant_id, created_at DESC);
