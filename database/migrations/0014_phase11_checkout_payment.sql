DO $$ BEGIN
  CREATE TYPE membership_price_status AS ENUM ('ACTIVE', 'RETIRED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE membership_price_period_unit AS ENUM ('MONTH', 'YEAR');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE membership_payment_currency AS ENUM ('VND');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE membership_order_status AS ENUM ('PENDING_PAYMENT', 'PAID', 'FAILED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE membership_payment_attempt_status AS ENUM (
    'CREATED',
    'PENDING',
    'PAID',
    'FAILED',
    'CANCELLED',
    'EXPIRED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS membership_plan_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_id uuid NOT NULL REFERENCES membership_plan_versions(id) ON DELETE RESTRICT,
  price_code varchar(64) NOT NULL,
  status membership_price_status NOT NULL DEFAULT 'ACTIVE',
  amount_minor bigint NOT NULL,
  currency membership_payment_currency NOT NULL DEFAULT 'VND',
  period_unit membership_price_period_unit NOT NULL,
  period_count smallint NOT NULL,
  available_from timestamptz NOT NULL DEFAULT now(),
  available_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT membership_plan_price_unique UNIQUE (plan_version_id, price_code),
  CONSTRAINT membership_plan_price_code_check CHECK (
    price_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'
  ),
  CONSTRAINT membership_plan_price_amount_check CHECK (
    amount_minor > 0 AND amount_minor <= 9007199254740991
  ),
  CONSTRAINT membership_plan_price_period_count_check CHECK (
    period_count > 0
  ),
  CONSTRAINT membership_plan_price_period_check CHECK (
    available_until IS NULL OR available_until > available_from
  )
);

CREATE INDEX IF NOT EXISTS membership_plan_prices_purchase_idx
  ON membership_plan_prices (plan_version_id, status, available_from, available_until, price_code);

CREATE TABLE IF NOT EXISTS membership_checkout_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan_version_id uuid NOT NULL REFERENCES membership_plan_versions(id) ON DELETE RESTRICT,
  price_id uuid NOT NULL REFERENCES membership_plan_prices(id) ON DELETE RESTRICT,
  product_code varchar(64) NOT NULL,
  plan_version integer NOT NULL,
  plan_display_name varchar(120) NOT NULL,
  price_code varchar(64) NOT NULL,
  amount_minor bigint NOT NULL,
  currency membership_payment_currency NOT NULL,
  period_unit membership_price_period_unit NOT NULL,
  period_count smallint NOT NULL,
  status membership_order_status NOT NULL DEFAULT 'PENDING_PAYMENT',
  idempotency_key_hash varchar(64) NOT NULL,
  request_hash varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT membership_orders_owner_idempotency_unique UNIQUE (user_id, idempotency_key_hash),
  CONSTRAINT membership_checkout_order_amount_check CHECK (
    amount_minor > 0 AND amount_minor <= 9007199254740991
  ),
  CONSTRAINT membership_checkout_order_plan_version_check CHECK (plan_version > 0),
  CONSTRAINT membership_checkout_order_period_count_check CHECK (period_count > 0),
  CONSTRAINT membership_checkout_order_product_code_check CHECK (
    product_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  CONSTRAINT membership_checkout_order_hash_check CHECK (
    idempotency_key_hash ~ '^[0-9a-f]{64}$' AND request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT membership_checkout_order_display_name_check CHECK (
    char_length(plan_display_name) BETWEEN 1 AND 120 AND char_length(btrim(plan_display_name)) > 0
  )
);

CREATE INDEX IF NOT EXISTS membership_checkout_orders_user_status_idx
  ON membership_checkout_orders (user_id, status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS membership_payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES membership_checkout_orders(id) ON DELETE RESTRICT,
  provider_code varchar(32) NOT NULL,
  local_attempt_reference varchar(128) NOT NULL UNIQUE,
  provider_reference varchar(200),
  checkout_url text,
  amount_minor bigint NOT NULL,
  currency membership_payment_currency NOT NULL,
  status membership_payment_attempt_status NOT NULL DEFAULT 'CREATED',
  idempotency_key_hash varchar(64) NOT NULL,
  request_hash varchar(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  failure_code varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT membership_payment_attempts_owner_idempotency_unique UNIQUE (user_id, idempotency_key_hash),
  CONSTRAINT membership_payment_attempts_provider_reference_unique UNIQUE (provider_code, provider_reference),
  CONSTRAINT membership_payment_attempts_amount_check CHECK (
    amount_minor > 0 AND amount_minor <= 9007199254740991
  ),
  CONSTRAINT membership_payment_attempts_reference_check CHECK (
    char_length(btrim(provider_code)) BETWEEN 1 AND 32 AND
    char_length(btrim(local_attempt_reference)) BETWEEN 1 AND 128 AND
    (provider_reference IS NULL OR char_length(btrim(provider_reference)) BETWEEN 1 AND 200) AND
    (failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{1,64}$')
  ),
  CONSTRAINT membership_payment_attempts_hash_check CHECK (
    idempotency_key_hash ~ '^[0-9a-f]{64}$' AND request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT membership_payment_attempts_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT membership_payment_attempts_provider_state_check CHECK (
    status NOT IN ('PENDING', 'PAID') OR provider_reference IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS membership_payment_attempts_one_open_per_order
  ON membership_payment_attempts (order_id)
  WHERE status IN ('CREATED', 'PENDING');

CREATE INDEX IF NOT EXISTS membership_payment_attempts_order_history_idx
  ON membership_payment_attempts (order_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS membership_payment_attempts_user_status_idx
  ON membership_payment_attempts (user_id, status, created_at DESC, id DESC);
