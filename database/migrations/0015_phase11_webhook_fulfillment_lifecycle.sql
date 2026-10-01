CREATE TABLE IF NOT EXISTS membership_payment_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code varchar(32) NOT NULL,
  event_key varchar(64) NOT NULL,
  event_type varchar(32) NOT NULL,
  payload_hash varchar(64) NOT NULL,
  outcome varchar(32) NOT NULL,
  reason_code varchar(64),
  sanitized_fact jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT membership_payment_webhook_event_identity_unique
    UNIQUE (provider_code, event_key, payload_hash),
  CONSTRAINT membership_payment_webhook_event_key_check CHECK (
    event_key ~ '^[0-9a-f]{64}$' AND payload_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT membership_payment_webhook_event_type_check CHECK (
    event_type IN ('PAYMENT_SUCCEEDED', 'PAYMENT_FAILED')
  ),
  CONSTRAINT membership_payment_webhook_event_outcome_check CHECK (
    outcome IN (
      'RECEIVED',
      'SETTLEMENT_RECORDED',
      'PAYMENT_FAILED',
      'FULFILLED',
      'FULFILLMENT_RETRYABLE',
      'REPLAYED',
      'REJECTED'
    )
  ),
  CONSTRAINT membership_payment_webhook_event_reason_check CHECK (
    reason_code IS NULL OR reason_code ~ '^[A-Z0-9_]{1,64}$'
  ),
  CONSTRAINT membership_payment_webhook_event_fact_check CHECK (
    jsonb_typeof(sanitized_fact) = 'object'
  )
);

CREATE INDEX IF NOT EXISTS membership_payment_webhook_events_reference_idx
  ON membership_payment_webhook_events (provider_code, event_key, received_at DESC);

CREATE TABLE IF NOT EXISTS membership_payment_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code varchar(32) NOT NULL,
  event_id uuid NOT NULL REFERENCES membership_payment_webhook_events(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES membership_checkout_orders(id) ON DELETE RESTRICT,
  attempt_id uuid NOT NULL REFERENCES membership_payment_attempts(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_reference varchar(200) NOT NULL,
  amount_minor bigint NOT NULL,
  currency membership_payment_currency NOT NULL,
  settled_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT membership_payment_settlements_attempt_unique UNIQUE (attempt_id),
  CONSTRAINT membership_payment_settlements_provider_reference_unique
    UNIQUE (provider_code, provider_reference),
  CONSTRAINT membership_payment_settlements_amount_check CHECK (
    amount_minor > 0 AND amount_minor <= 9007199254740991
  ),
  CONSTRAINT membership_payment_settlements_reference_check CHECK (
    char_length(btrim(provider_code)) BETWEEN 1 AND 32 AND
    char_length(btrim(provider_reference)) BETWEEN 1 AND 200
  )
);

CREATE INDEX IF NOT EXISTS membership_payment_settlements_order_idx
  ON membership_payment_settlements (order_id, settled_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS membership_payment_fulfillments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id uuid NOT NULL REFERENCES membership_payment_settlements(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES membership_checkout_orders(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status varchar(16) NOT NULL,
  subscription_id uuid REFERENCES membership_subscriptions(id) ON DELETE RESTRICT,
  failure_code varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT membership_payment_fulfillments_settlement_unique UNIQUE (settlement_id),
  CONSTRAINT membership_payment_fulfillments_order_unique UNIQUE (order_id),
  CONSTRAINT membership_payment_fulfillment_status_check CHECK (
    status IN ('PENDING', 'FULFILLED', 'RETRYABLE', 'REJECTED')
  ),
  CONSTRAINT membership_payment_fulfillment_failure_check CHECK (
    failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{1,64}$'
  ),
  CONSTRAINT membership_payment_fulfillment_subscription_check CHECK (
    status <> 'FULFILLED' OR subscription_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS membership_payment_fulfillments_user_status_idx
  ON membership_payment_fulfillments (user_id, status, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS membership_subscription_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES membership_subscriptions(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_type varchar(16) NOT NULL,
  source_id varchar(200) NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT membership_subscription_event_unique UNIQUE (subscription_id, event_type, source_id),
  CONSTRAINT membership_subscription_event_type_check CHECK (
    event_type IN ('ACTIVATED', 'EXPIRED', 'RENEWED', 'CANCELLED', 'REVOKED')
  ),
  CONSTRAINT membership_subscription_event_source_check CHECK (
    char_length(btrim(source_id)) BETWEEN 1 AND 200
  ),
  CONSTRAINT membership_subscription_event_period_check CHECK (
    ends_at IS NULL OR ends_at > starts_at
  ),
  CONSTRAINT membership_subscription_event_metadata_check CHECK (
    jsonb_typeof(metadata) = 'object'
  )
);

CREATE INDEX IF NOT EXISTS membership_subscription_events_user_time_idx
  ON membership_subscription_events (user_id, occurred_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS membership_credit_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan_version_id uuid NOT NULL REFERENCES membership_plan_versions(id) ON DELETE RESTRICT,
  subscription_id uuid NOT NULL REFERENCES membership_subscriptions(id) ON DELETE RESTRICT,
  credit_units integer NOT NULL,
  consumed_reputation_points integer NOT NULL,
  contract_version varchar(128) NOT NULL,
  rule_version varchar(64) NOT NULL,
  idempotency_key_hash varchar(64) NOT NULL,
  request_hash varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT membership_credit_redemptions_owner_idempotency_unique
    UNIQUE (user_id, idempotency_key_hash),
  CONSTRAINT membership_credit_redemptions_subscription_unique UNIQUE (subscription_id),
  CONSTRAINT membership_credit_redemptions_units_check CHECK (
    credit_units BETWEEN 1 AND 120 AND consumed_reputation_points = credit_units * 10
  ),
  CONSTRAINT membership_credit_redemptions_contract_check CHECK (
    char_length(btrim(contract_version)) BETWEEN 1 AND 128 AND
    char_length(btrim(rule_version)) BETWEEN 1 AND 64
  ),
  CONSTRAINT membership_credit_redemptions_hash_check CHECK (
    idempotency_key_hash ~ '^[0-9a-f]{64}$' AND request_hash ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX IF NOT EXISTS membership_credit_redemptions_user_time_idx
  ON membership_credit_redemptions (user_id, created_at DESC, id DESC);
