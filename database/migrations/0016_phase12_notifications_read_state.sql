CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id varchar(64) NOT NULL,
  deduplication_key varchar(300) NOT NULL,
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  notification_type varchar(32) NOT NULL,
  category varchar(32) NOT NULL,
  priority varchar(16) NOT NULL,
  actor jsonb NOT NULL,
  target jsonb,
  variables jsonb NOT NULL,
  retention jsonb NOT NULL,
  source_event_id uuid NOT NULL,
  source_event_type varchar(80) NOT NULL,
  source_event_version integer NOT NULL,
  source_aggregate_type varchar(64) NOT NULL,
  source_aggregate_id uuid NOT NULL,
  source_idempotency_key varchar(200) NOT NULL,
  source_payload_hash varchar(64) NOT NULL,
  intent_fingerprint varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_intent_unique UNIQUE (intent_id),
  CONSTRAINT notifications_deduplication_unique UNIQUE (deduplication_key),
  CONSTRAINT notifications_id_recipient_unique UNIQUE (id, recipient_user_id),
  CONSTRAINT notifications_intent_id_check CHECK (intent_id ~ '^[0-9a-f]{64}$'),
  CONSTRAINT notifications_deduplication_key_check CHECK (
    char_length(btrim(deduplication_key)) BETWEEN 1 AND 300
  ),
  CONSTRAINT notifications_type_check CHECK (
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
  ),
  CONSTRAINT notifications_category_check CHECK (
    category IN ('COMMUNITY', 'CORRECTIONS', 'EXCHANGE', 'REPUTATION', 'MEMBERSHIP', 'SECURITY', 'MODERATION', 'SYSTEM')
  ),
  CONSTRAINT notifications_priority_check CHECK (
    priority IN ('LOW', 'NORMAL', 'HIGH', 'CRITICAL')
  ),
  CONSTRAINT notifications_actor_check CHECK (jsonb_typeof(actor) = 'object'),
  CONSTRAINT notifications_target_check CHECK (target IS NULL OR jsonb_typeof(target) = 'object'),
  CONSTRAINT notifications_variables_check CHECK (jsonb_typeof(variables) = 'object'),
  CONSTRAINT notifications_retention_check CHECK (jsonb_typeof(retention) = 'object'),
  CONSTRAINT notifications_source_event_version_check CHECK (source_event_version > 0),
  CONSTRAINT notifications_source_idempotency_check CHECK (
    char_length(btrim(source_idempotency_key)) BETWEEN 1 AND 200
  ),
  CONSTRAINT notifications_hash_check CHECK (
    source_payload_hash ~ '^[0-9a-f]{64}$' AND intent_fingerprint ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX IF NOT EXISTS notifications_recipient_created_idx
  ON notifications (recipient_user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS notification_read_states (
  notification_id uuid PRIMARY KEY,
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status varchar(16) NOT NULL DEFAULT 'UNREAD',
  read_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_read_state_notification_owner_fk
    FOREIGN KEY (notification_id, recipient_user_id)
    REFERENCES notifications(id, recipient_user_id)
    ON DELETE CASCADE,
  CONSTRAINT notification_read_state_status_check CHECK (status IN ('UNREAD', 'READ')),
  CONSTRAINT notification_read_state_timestamp_check CHECK (
    (status = 'UNREAD' AND read_at IS NULL) OR
    (status = 'READ' AND read_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS notification_read_states_owner_status_idx
  ON notification_read_states (recipient_user_id, status, updated_at DESC, notification_id);
