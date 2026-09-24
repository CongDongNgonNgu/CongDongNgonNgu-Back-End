-- Phase 08B2A rollback: remove only the contribution-event objects owned by 0011.

DROP TABLE IF EXISTS library_contribution_events;
DROP TYPE IF EXISTS library_contribution_event_type;
