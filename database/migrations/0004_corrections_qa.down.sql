BEGIN;

DROP TABLE IF EXISTS community_structured_response_votes;
DROP TABLE IF EXISTS community_structured_response_acceptances;
DROP TABLE IF EXISTS community_structured_responses;
DROP TRIGGER IF EXISTS community_correction_original_immutable
  ON community_correction_requests;
DROP TABLE IF EXISTS community_correction_requests;

DROP FUNCTION IF EXISTS phase06_prevent_correction_original_update();

DROP TYPE IF EXISTS phase06_structured_response_vote_type;
DROP TYPE IF EXISTS phase06_structured_response_kind;
DROP TYPE IF EXISTS phase06_correction_intent;

COMMIT;
