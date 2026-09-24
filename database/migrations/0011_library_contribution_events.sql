-- Phase 08B2A: durable community contribution facts for future Phase 10.
-- This migration is intentionally review-only in 08B2A and MUST NOT be applied
-- until the backend contract and schema receive external authorization.

DO $$ BEGIN
  CREATE TYPE library_contribution_event_type AS ENUM (
    'LIBRARY_CONTRIBUTION_SUBMITTED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS library_contribution_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type library_contribution_event_type NOT NULL,
  event_version integer NOT NULL,
  resource_id uuid NOT NULL REFERENCES library_resources(id) ON DELETE RESTRICT,
  contributor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  review_audit_id uuid NOT NULL REFERENCES library_resource_review_audits(id) ON DELETE RESTRICT,
  resource_type library_resource_type NOT NULL,
  terms_version varchar(80) NOT NULL,
  rights_confirmed boolean NOT NULL,
  reuse_consent boolean NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_contribution_event_version_check
    CHECK (event_version > 0),
  CONSTRAINT library_contribution_event_terms_check
    CHECK (char_length(terms_version) BETWEEN 1 AND 80 AND length(btrim(terms_version)) > 0),
  CONSTRAINT library_contribution_event_rights_check
    CHECK (rights_confirmed IS TRUE),
  CONSTRAINT library_contribution_event_reuse_check
    CHECK (reuse_consent IS TRUE),
  CONSTRAINT library_contribution_event_review_audit_unique
    UNIQUE (review_audit_id)
);

CREATE INDEX IF NOT EXISTS library_contribution_events_resource_idx
  ON library_contribution_events (resource_id, occurred_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS library_contribution_events_contributor_idx
  ON library_contribution_events (contributor_user_id, occurred_at ASC, id ASC);
