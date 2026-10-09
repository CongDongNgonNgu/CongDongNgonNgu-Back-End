-- Internal intent delivery state; no actor/profile/message snapshots.
-- No connection FK: removal must leave the intent available for suppression.
CREATE TABLE exchange_notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  event_kind varchar(16) NOT NULL CHECK (event_kind IN ('REQUESTED','CONNECTED')),
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_a_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_b_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  lease_token uuid,
  leased_until timestamptz,
  status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DELIVERED','SUPPRESSED')),
  handled_at timestamptz,
  UNIQUE(connection_id,event_kind,recipient_id),
  CHECK (participant_a_id<participant_b_id),
  CHECK (actor_id IN (participant_a_id,participant_b_id)),
  CHECK (recipient_id IN (participant_a_id,participant_b_id) AND actor_id<>recipient_id),
  CHECK ((lease_token IS NULL)=(leased_until IS NULL)),
  CHECK ((status='PENDING')=(handled_at IS NULL))
);
CREATE INDEX exchange_notification_outbox_pending_idx
  ON exchange_notification_outbox(available_at,id) WHERE status='PENDING';
