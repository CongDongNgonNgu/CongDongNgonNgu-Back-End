DO $$ BEGIN
  CREATE TYPE membership_product_status AS ENUM ('ACTIVE', 'RETIRED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE membership_plan_version_status AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE membership_subscription_status AS ENUM (
    'SCHEDULED',
    'ACTIVE',
    'EXPIRED',
    'CANCELLED',
    'REVOKED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE membership_subscription_source AS ENUM (
    'DEFAULT_FREE',
    'ADMIN_GRANT',
    'CONTRIBUTION_CREDIT',
    'PURCHASE'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS membership_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code varchar(64) NOT NULL UNIQUE,
  display_name varchar(120) NOT NULL,
  status membership_product_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT membership_product_code_check CHECK (
    product_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  CONSTRAINT membership_product_display_name_check CHECK (
    char_length(display_name) BETWEEN 1 AND 120 AND char_length(btrim(display_name)) > 0
  )
);

CREATE TABLE IF NOT EXISTS membership_plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES membership_products(id) ON DELETE RESTRICT,
  version integer NOT NULL,
  status membership_plan_version_status NOT NULL DEFAULT 'DRAFT',
  display_name varchar(120) NOT NULL,
  description varchar(500) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  retired_at timestamptz,
  CONSTRAINT membership_plan_version_unique UNIQUE (product_id, version),
  CONSTRAINT membership_plan_version_number_check CHECK (version > 0),
  CONSTRAINT membership_plan_version_display_name_check CHECK (
    char_length(display_name) BETWEEN 1 AND 120 AND char_length(btrim(display_name)) > 0
  ),
  CONSTRAINT membership_plan_version_description_check CHECK (
    char_length(description) BETWEEN 1 AND 500 AND char_length(btrim(description)) > 0
  ),
  CONSTRAINT membership_plan_version_activation_check CHECK (
    status = 'DRAFT' OR activated_at IS NOT NULL
  )
);

CREATE TABLE IF NOT EXISTS membership_entitlement_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_version_id uuid NOT NULL REFERENCES membership_plan_versions(id) ON DELETE RESTRICT,
  feature_key varchar(120) NOT NULL,
  limit_value integer,
  limit_unit varchar(64),
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT membership_entitlement_unique UNIQUE (product_version_id, feature_key),
  CONSTRAINT membership_entitlement_feature_key_check CHECK (
    feature_key ~ '^[a-z0-9][a-z0-9._-]{0,119}$'
  ),
  CONSTRAINT membership_entitlement_limit_check CHECK (
    limit_value IS NULL OR limit_value >= 0
  ),
  CONSTRAINT membership_entitlement_limit_unit_check CHECK (
    limit_unit IS NULL OR (char_length(limit_unit) BETWEEN 1 AND 64 AND char_length(btrim(limit_unit)) > 0)
  ),
  CONSTRAINT membership_entitlement_limit_pair_check CHECK (
    limit_value IS NOT NULL OR limit_unit IS NULL
  ),
  CONSTRAINT membership_entitlement_parameters_check CHECK (
    jsonb_typeof(parameters) = 'object'
  )
);

CREATE TABLE IF NOT EXISTS membership_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  product_version_id uuid NOT NULL REFERENCES membership_plan_versions(id) ON DELETE RESTRICT,
  status membership_subscription_status NOT NULL,
  source membership_subscription_source NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  cancelled_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT membership_subscription_period_check CHECK (
    ends_at IS NULL OR ends_at > starts_at
  ),
  CONSTRAINT membership_subscription_cancelled_timestamp_check CHECK (
    cancelled_at IS NULL OR status = 'CANCELLED'
  ),
  CONSTRAINT membership_subscription_revoked_timestamp_check CHECK (
    revoked_at IS NULL OR status = 'REVOKED'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS membership_subscriptions_active_user_unique
  ON membership_subscriptions (user_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS membership_plan_versions_status_idx
  ON membership_plan_versions (product_id, status, version DESC);

CREATE INDEX IF NOT EXISTS membership_entitlement_feature_idx
  ON membership_entitlement_definitions (feature_key, product_version_id);

CREATE INDEX IF NOT EXISTS membership_subscriptions_user_period_idx
  ON membership_subscriptions (user_id, starts_at DESC, updated_at DESC, id DESC);
