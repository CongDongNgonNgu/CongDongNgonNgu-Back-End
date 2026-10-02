BEGIN;

DO $$ BEGIN
  CREATE TYPE event_visibility AS ENUM ('PUBLIC', 'PRIVATE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE event_venue_type AS ENUM ('SPEAKING_ROOM', 'EXTERNAL', 'PHYSICAL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE event_status AS ENUM ('SCHEDULED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE event_recurrence_frequency AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS event_recurrence_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  timezone varchar(64) NOT NULL,
  frequency event_recurrence_frequency NOT NULL,
  recurrence_interval smallint NOT NULL,
  occurrence_count smallint,
  occurrence_until_at timestamptz,
  by_weekdays varchar(2)[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_recurrence_timezone_check CHECK (length(btrim(timezone)) BETWEEN 1 AND 64),
  CONSTRAINT event_recurrence_interval_check CHECK (recurrence_interval BETWEEN 1 AND 30),
  CONSTRAINT event_recurrence_bound_check CHECK (
    (occurrence_count IS NOT NULL AND occurrence_until_at IS NULL)
    OR (occurrence_count IS NULL AND occurrence_until_at IS NOT NULL)
  ),
  CONSTRAINT event_recurrence_count_check CHECK (occurrence_count IS NULL OR occurrence_count BETWEEN 2 AND 100),
  CONSTRAINT event_recurrence_weekday_check CHECK (
    by_weekdays <@ ARRAY['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']::varchar[]
  )
);

CREATE TABLE IF NOT EXISTS community_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title varchar(160) NOT NULL,
  language_id uuid NOT NULL REFERENCES languages(id) ON DELETE RESTRICT,
  level varchar(8),
  topic varchar(160),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone varchar(64) NOT NULL,
  capacity smallint NOT NULL,
  visibility event_visibility NOT NULL DEFAULT 'PUBLIC',
  venue_type event_venue_type NOT NULL,
  speaking_room_id uuid REFERENCES speaking_rooms(id) ON DELETE RESTRICT,
  recurrence_series_id uuid REFERENCES event_recurrence_series(id) ON DELETE RESTRICT,
  status event_status NOT NULL DEFAULT 'SCHEDULED',
  cancelled_at timestamptz,
  cancelled_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT community_events_title_check CHECK (length(btrim(title)) BETWEEN 3 AND 160),
  CONSTRAINT community_events_level_check CHECK (level IS NULL OR level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  CONSTRAINT community_events_topic_check CHECK (topic IS NULL OR length(btrim(topic)) BETWEEN 1 AND 160),
  CONSTRAINT community_events_time_check CHECK (ends_at > starts_at),
  CONSTRAINT community_events_timezone_check CHECK (length(btrim(timezone)) BETWEEN 1 AND 64),
  CONSTRAINT community_events_capacity_check CHECK (capacity BETWEEN 1 AND 1000),
  CONSTRAINT community_events_venue_room_check CHECK (
    (venue_type = 'SPEAKING_ROOM'::event_venue_type AND speaking_room_id IS NOT NULL)
    OR (venue_type <> 'SPEAKING_ROOM'::event_venue_type AND speaking_room_id IS NULL)
  ),
  CONSTRAINT community_events_cancel_state_check CHECK (
    (status = 'CANCELLED'::event_status AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL)
    OR (status <> 'CANCELLED'::event_status AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS event_recurrence_series_host_idx
  ON event_recurrence_series (host_user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS community_events_public_listing_idx
  ON community_events (visibility, status, starts_at, id);

CREATE INDEX IF NOT EXISTS community_events_host_idx
  ON community_events (host_user_id, starts_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS community_events_series_idx
  ON community_events (recurrence_series_id, starts_at, id);

COMMIT;
