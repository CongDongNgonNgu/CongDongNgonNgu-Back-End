BEGIN;

DROP TABLE IF EXISTS community_events;
DROP TABLE IF EXISTS event_recurrence_series;

DROP TYPE IF EXISTS event_recurrence_frequency;
DROP TYPE IF EXISTS event_status;
DROP TYPE IF EXISTS event_venue_type;
DROP TYPE IF EXISTS event_visibility;

COMMIT;
