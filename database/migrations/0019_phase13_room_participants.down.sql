BEGIN;

DROP TABLE IF EXISTS speaking_room_participant_actions;
DROP TABLE IF EXISTS speaking_room_participants;
DROP TYPE IF EXISTS speaking_room_participant_action;
DROP TYPE IF EXISTS speaking_room_participant_state;
DROP TYPE IF EXISTS speaking_room_participant_role;

COMMIT;
