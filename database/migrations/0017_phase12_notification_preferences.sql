CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category varchar(32) NOT NULL,
  channel varchar(16) NOT NULL,
  enabled boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category, channel),
  CONSTRAINT notification_preferences_category_check CHECK (
    category IN ('COMMUNITY', 'CORRECTIONS', 'EXCHANGE', 'REPUTATION', 'MEMBERSHIP', 'SECURITY', 'MODERATION', 'SYSTEM')
  ),
  CONSTRAINT notification_preferences_channel_check CHECK (
    channel IN ('IN_APP', 'SSE', 'EMAIL', 'PUSH')
  )
);

CREATE INDEX IF NOT EXISTS notification_preferences_user_updated_idx
  ON notification_preferences (user_id, updated_at DESC, category, channel);
