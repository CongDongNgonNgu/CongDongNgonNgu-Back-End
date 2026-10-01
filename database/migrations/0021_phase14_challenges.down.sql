BEGIN;

DROP TABLE IF EXISTS challenge_progress_events;
DROP TABLE IF EXISTS challenge_participations;
DROP TABLE IF EXISTS challenges;

DROP TYPE IF EXISTS challenge_participation_status;
DROP TYPE IF EXISTS challenge_status;
DROP TYPE IF EXISTS challenge_activity_type;
DROP TYPE IF EXISTS challenge_goal_unit;
DROP TYPE IF EXISTS challenge_type;

COMMIT;
