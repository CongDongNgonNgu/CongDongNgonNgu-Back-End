BEGIN;

ALTER TABLE community_reports
  ADD COLUMN IF NOT EXISTS assigned_to_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolution_reason varchar(1000);

CREATE TABLE IF NOT EXISTS community_report_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES community_reports(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body varchar(2000) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT community_report_notes_body_check
    CHECK (char_length(body) BETWEEN 1 AND 2000 AND length(btrim(body)) > 0)
);

CREATE INDEX IF NOT EXISTS community_reports_assigned_state_idx
  ON community_reports (state, assigned_to_user_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS community_report_notes_report_idx
  ON community_report_notes (report_id, created_at ASC, id ASC);

COMMIT;
