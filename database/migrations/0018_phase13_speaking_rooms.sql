DO $$ BEGIN
  CREATE TYPE speaking_room_visibility AS ENUM ('PUBLIC', 'PRIVATE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE speaking_room_lifecycle AS ENUM ('SCHEDULED', 'LIVE', 'ENDED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS speaking_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  language_id uuid NOT NULL REFERENCES languages(id) ON DELETE RESTRICT,
  level varchar(8),
  topic varchar(160) NOT NULL,
  visibility speaking_room_visibility NOT NULL,
  lifecycle speaking_room_lifecycle NOT NULL DEFAULT 'LIVE',
  capacity smallint NOT NULL DEFAULT 20,
  access_token_hash varchar(64),
  scheduled_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT speaking_rooms_level_check CHECK (level IS NULL OR level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  CONSTRAINT speaking_rooms_topic_check CHECK (length(btrim(topic)) BETWEEN 1 AND 160),
  CONSTRAINT speaking_rooms_capacity_check CHECK (capacity BETWEEN 2 AND 100),
  CONSTRAINT speaking_rooms_private_access_check CHECK (
    (visibility = 'PUBLIC'::speaking_room_visibility AND access_token_hash IS NULL)
    OR (visibility = 'PRIVATE'::speaking_room_visibility AND access_token_hash IS NOT NULL)
  ),
  CONSTRAINT speaking_rooms_schedule_check CHECK (
    (lifecycle = 'SCHEDULED'::speaking_room_lifecycle AND scheduled_at IS NOT NULL)
    OR (lifecycle <> 'SCHEDULED'::speaking_room_lifecycle AND scheduled_at IS NULL)
  ),
  CONSTRAINT speaking_rooms_timeline_check CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS speaking_rooms_public_listing_idx
  ON speaking_rooms (visibility, lifecycle, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS speaking_rooms_host_idx
  ON speaking_rooms (host_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS speaking_room_moderators (
  room_id uuid NOT NULL REFERENCES speaking_rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS speaking_room_moderators_user_idx
  ON speaking_room_moderators (user_id, room_id);
